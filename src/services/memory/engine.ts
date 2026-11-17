import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { request, API_ORIGIN } from '../api/client.js'
import { useSettings } from '../settings.js'
import * as chats from '../chat/db.js'
import { getVisibleMessages } from '../chat/branches.js'
import type { Session } from '../chat/types.js'
import * as db from './db.js'
import { isForgetAllCommand, looksLikeSecret, parseExtraction } from './policy.js'
import { rankHistory, rankMemories, tokenize } from './retrieval.js'
import { MEMORY_EXTRACTION_PROMPT, formatMemoryContext } from './prompts.js'
import type { HistoryChunk, MemorySource, SavedMemory } from './types.js'

type MemoryState = {
  ready: boolean
  saved: SavedMemory[]
  excluded: string[]
  nextChatExcluded: boolean
  indexing: boolean
  indexed: number
  total: number
  error: 'storage' | 'index' | null
  updating: number
}
export const useMemoryState = create<MemoryState>(() => ({
  ready: false,
  saved: [],
  excluded: [],
  nextChatExcluded: false,
  indexing: false,
  indexed: 0,
  total: 0,
  error: null,
  updating: 0,
}))
let initialization: Promise<void> | undefined
let revision = 0
let indexEpoch = 0
let rebuilding: Promise<void> | undefined
let rebuildingEpoch = 0
let updateQueue: Promise<unknown> = Promise.resolve()
const updateJobs = new Map<string, { sessionId: string; controller: AbortController }>()
const sessionRevisions = new Map<string, number>()
const indexTasks = new Map<string, Promise<void>>()

const enabledHistory = () => {
  const settings = useSettings.getState()
  return settings.memoryEnabled && settings.memoryHistory
}
const enabledAuto = () => {
  const settings = useSettings.getState()
  return settings.memoryEnabled && settings.memoryAuto
}
export const isMemoryExcluded = (sessionId: string) =>
  useMemoryState.getState().excluded.includes(sessionId)

export const initMemory = () =>
  (initialization ??= (async () => {
    const [saved, excluded] = await Promise.all([db.loadMemories(), db.loadExclusions()])
    useMemoryState.setState({ ready: true, saved, excluded, error: null })
  })().catch((error) => {
    initialization = undefined
    useMemoryState.setState({ error: 'storage' })
    throw error
  }))

const refreshSaved = async () => useMemoryState.setState({ saved: await db.loadMemories() })

export const saveMemory = async (text: string, id?: string) => {
  await initMemory()
  const content = text.trim()
  if (!content || content.length > 1000 || looksLikeSecret(content)) {
    throw new Error('memoryInvalidContent')
  }
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  const previous = useMemoryState.getState().saved.find((memory) => memory.id === id)
  const now = Date.now()
  await db.putMemory({
    id: previous?.id ?? createId(),
    text: content,
    key: previous?.key ?? `manual.${createId()}`,
    origin: 'manual',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(previous?.sourceSessionId
      ? { sourceSessionId: previous.sourceSessionId, sourceMessageId: previous.sourceMessageId }
      : {}),
  })
  await refreshSaved()
}

export const forgetMemory = async (id: string) => {
  await initMemory()
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  await db.deleteMemory(id)
  await refreshSaved()
}
export const clearSavedMemories = async () => {
  await initMemory()
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  await db.clearMemories()
  await refreshSaved()
}

export const setSessionMemoryExcluded = async (sessionId: string | null, excluded: boolean) => {
  await initMemory()
  if (sessionId === null) {
    useMemoryState.setState({ nextChatExcluded: excluded })
    return
  }
  const previous = useMemoryState.getState().excluded
  useMemoryState.setState({
    excluded: excluded
      ? [...new Set([...previous, sessionId])]
      : previous.filter((id) => id !== sessionId),
  })
  sessionRevisions.set(sessionId, (sessionRevisions.get(sessionId) ?? 0) + 1)
  for (const job of updateJobs.values()) {
    if (job.sessionId === sessionId) {
      job.controller.abort()
    }
  }
  await db.writeExclusion(sessionId, excluded)
  if (excluded) {
    await db.deleteSessionIndex(sessionId)
  } else {
    const session = await chats.loadSession(sessionId)
    if (session) {
      await queueSessionIndex(session)
    }
  }
}

/** Called synchronously before the first reply, so an excluded new chat never leaks into context. */
export const adoptNewChatMemory = (id: string) => {
  if (!useMemoryState.getState().nextChatExcluded) {
    return
  }
  useMemoryState.setState((state) => ({
    nextChatExcluded: false,
    excluded: [...state.excluded, id],
  }))
  void db.writeExclusion(id, true).catch(() => useMemoryState.setState({ error: 'storage' }))
}

const hash = (text: string) => {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  }
  return String(value >>> 0)
}

const sessionText = (session: Session): { message: Session['messages'][number]; text: string }[] =>
  getVisibleMessages(session).flatMap<{ message: Session['messages'][number]; text: string }>(
    (message) => {
      if (message.role === 'user') {
        return message.content.trim() && !looksLikeSecret(message.content)
          ? [{ message, text: message.content }]
          : []
      }
      if (message.status !== 'done' || message.stopReason === 'refusal') {
        return []
      }
      const text = message.blocks
        .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
        .join('\n')
      return text.trim() && !looksLikeSecret(text) ? [{ message, text }] : []
    }
  )

const indexOne = async (session: Session, epoch: number, generation: number) => {
  if (!enabledHistory() || isMemoryExcluded(session.id) || epoch !== indexEpoch) {
    return
  }
  const messages = sessionText(session)
  const fingerprint = hash(
    JSON.stringify([session.title, messages.map(({ message, text }) => [message.id, text])])
  )
  if ((await db.getCatalog(session.id))?.fingerprint === fingerprint) {
    return
  }
  const chunks: HistoryChunk[] = []
  for (const { message, text } of messages) {
    for (let start = 0; start < text.length; start += 700) {
      const excerpt = text.slice(start, start + 800)
      chunks.push({
        id: `${String(message.createdAt).padStart(13, '0')}:${session.id}:${message.id}:${start}`,
        sessionId: session.id,
        messageId: message.id,
        title: session.title,
        text: excerpt,
        role: message.role,
        createdAt: message.createdAt,
        terms: tokenize(`${session.title}\n${excerpt}`).slice(0, 180),
      })
    }
  }
  if (
    !enabledHistory() ||
    isMemoryExcluded(session.id) ||
    epoch !== indexEpoch ||
    generation !== (sessionRevisions.get(session.id) ?? 0)
  ) {
    return
  }
  // Confirm the source was not deleted or replaced while its index was being prepared.
  const current = await chats.loadSession(session.id)
  if (
    !current ||
    hash(
      JSON.stringify([
        current.title,
        sessionText(current).map(({ message, text }) => [message.id, text]),
      ])
    ) !== fingerprint
  ) {
    return
  }
  await db.writeSessionIndex({ id: session.id, fingerprint }, chunks)
  // A setting can change during the IndexedDB transaction; remove stale results afterwards.
  if (
    !enabledHistory() ||
    isMemoryExcluded(session.id) ||
    epoch !== indexEpoch ||
    generation !== (sessionRevisions.get(session.id) ?? 0)
  ) {
    await db.deleteSessionIndex(session.id)
  }
}

export const queueSessionIndex = (session: Session): Promise<void> => {
  if (
    !enabledHistory() ||
    session.messages.some(
      (message) => message.role === 'assistant' && ['pending', 'streaming'].includes(message.status)
    )
  ) {
    return Promise.resolve()
  }
  const epoch = indexEpoch
  const generation = sessionRevisions.get(session.id) ?? 0
  const previous = indexTasks.get(session.id) ?? Promise.resolve()
  const task = previous
    .catch(() => {})
    .then(async () => {
      await initMemory()
      await indexOne(session, epoch, generation)
    })
    .catch(() => {
      useMemoryState.setState({ error: 'index' })
    })
    .finally(() => {
      if (indexTasks.get(session.id) === task) {
        indexTasks.delete(session.id)
      }
    })
  indexTasks.set(session.id, task)
  return task
}

export const rebuildHistoryIndex = async (force = false): Promise<void> => {
  await initMemory()
  if (!enabledHistory()) {
    return
  }
  if (rebuilding) {
    if (rebuildingEpoch !== indexEpoch) {
      await rebuilding
      return rebuildHistoryIndex(force)
    }
    return rebuilding
  }
  const epoch = indexEpoch
  rebuildingEpoch = epoch
  rebuilding = (async () => {
    if (force) {
      await db.clearHistoryIndex()
    }
    const summaries = await chats.loadSessionSummaries()
    const ids = new Set(summaries.map((session) => session.id))
    for (const entry of await db.loadCatalog()) {
      if (!ids.has(entry.id)) {
        await db.deleteSessionIndex(entry.id)
      }
    }
    useMemoryState.setState({ indexing: true, indexed: 0, total: summaries.length, error: null })
    for (const [index, summary] of summaries.entries()) {
      if (epoch !== indexEpoch || !enabledHistory()) {
        return
      }
      const session = await chats.loadSession(summary.id)
      if (session) {
        await queueSessionIndex(session)
      }
      useMemoryState.setState({ indexed: index + 1 })
      // Return control to the interface between conversations, including large imported archives.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })()
    .catch(() => useMemoryState.setState({ error: 'index' }))
    .finally(() => {
      rebuilding = undefined
      useMemoryState.setState({ indexing: false })
    })
  return rebuilding
}

export const invalidateMemoryHistory = async () => {
  indexEpoch++
  updateJobs.forEach((job) => job.controller.abort())
  await db.clearHistoryIndex()
  useMemoryState.setState({ indexed: 0, total: 0 })
}
export const removeSessionMemoryIndex = async (id: string) => {
  sessionRevisions.set(id, (sessionRevisions.get(id) ?? 0) + 1)
  for (const job of updateJobs.values()) {
    if (job.sessionId === id) {
      job.controller.abort()
    }
  }
  await db.deleteSessionIndex(id)
}

export const buildMemoryContext = async (
  sessionId: string,
  question: string,
  signal: AbortSignal
) => {
  await initMemory()
  if (
    useMemoryState.getState().updating > 0 &&
    useSettings.getState().memoryEnabled &&
    !isMemoryExcluded(sessionId)
  ) {
    // A follow-up must not race a just-requested "remember this" update.
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) {
        aborted()
        return
      }
      signal.addEventListener('abort', aborted, { once: true })
      void updateQueue
        .catch(() => {})
        .then(() => {
          signal.removeEventListener('abort', aborted)
          resolve()
        })
    })
  }
  if (signal.aborted) {
    throw signal.reason
  }
  if (!useSettings.getState().memoryEnabled || isMemoryExcluded(sessionId)) {
    return { sources: [] as MemorySource[], context: '' }
  }
  const sources: MemorySource[] = []
  let remaining = 3200
  for (const memory of rankMemories(useMemoryState.getState().saved, question)) {
    if (memory.text.length > remaining) {
      continue
    }
    remaining -= memory.text.length
    sources.push({
      id: memory.id,
      kind: 'saved',
      title: memory.origin === 'manual' ? '手动记忆' : '自动记忆',
      excerpt: memory.text,
      sessionId: memory.sourceSessionId,
      messageId: memory.sourceMessageId,
      updatedAt: memory.updatedAt,
    })
  }
  if (enabledHistory()) {
    const candidates = await db.findHistoryChunks(tokenize(question))
    const available = candidates.filter((chunk) => !isMemoryExcluded(chunk.sessionId))
    for (const chunk of rankHistory(available, question, sessionId)) {
      // Recheck source liveness before disclosure, even if index cleanup was interrupted.
      const original = await chats.loadSession(chunk.sessionId)
      if (
        !original ||
        !getVisibleMessages(original).some((message) => message.id === chunk.messageId)
      ) {
        continue
      }
      sources.push({
        id: chunk.id,
        kind: 'history',
        title: chunk.title || '历史对话',
        excerpt: chunk.text.slice(0, 650),
        sessionId: chunk.sessionId,
        messageId: chunk.messageId,
        role: chunk.role,
        updatedAt: chunk.createdAt,
      })
    }
  }
  if (signal.aborted) {
    throw signal.reason
  }
  if (!useSettings.getState().memoryEnabled || isMemoryExcluded(sessionId)) {
    return { sources: [] as MemorySource[], context: '' }
  }
  const valid = sources.filter((source) =>
    source.kind === 'saved'
      ? useMemoryState
          .getState()
          .saved.some((memory) => memory.id === source.id && memory.text === source.excerpt)
      : enabledHistory() && !isMemoryExcluded(source.sessionId ?? '')
  )
  return {
    sources: valid,
    context: formatMemoryContext(valid),
  }
}

export const shouldExtractMemory = (text: string) =>
  isForgetAllCommand(text) ||
  (!looksLikeSecret(text) &&
    /记住|忘记|删[除掉].{0,12}记忆|叫我|我.{0,10}(喜欢|偏好|习惯|使用|用|住|养|工作|开发|项目|计划|准备|正在|目前|希望|是|叫|有)|请.{0,8}(简短|中文|英文|回答)|\b(?:i|my|remember|forget|prefer|delete.{0,20}memor|remove.{0,20}memor)\b/i.test(
      text
    ))

export const updateMemoryFromTurn = (
  sessionId: string,
  messageId: string,
  userText: string
): Promise<'updated' | 'unchanged'> => {
  const sourceId = `${sessionId}:${messageId}`
  const enqueueRevision = revision
  const enqueueGeneration = sessionRevisions.get(sessionId) ?? 0
  const run = async (): Promise<'updated' | 'unchanged'> => {
    await initMemory()
    if (
      !enabledAuto() ||
      revision !== enqueueRevision ||
      enqueueGeneration !== (sessionRevisions.get(sessionId) ?? 0) ||
      isMemoryExcluded(sessionId) ||
      !shouldExtractMemory(userText) ||
      (await db.hasProcessed(sourceId))
    ) {
      return 'unchanged'
    }
    if (!(await chats.loadSession(sessionId))) {
      return 'unchanged'
    }
    if (isForgetAllCommand(userText)) {
      await clearSavedMemories()
      await db.markProcessed(sourceId)
      return 'updated'
    }
    const apiKey = useSettings.getState().apiKey
    if (!apiKey) {
      throw new Error('memoryNoApiKey')
    }
    const controller = new AbortController()
    const startRevision = revision
    const generation = sessionRevisions.get(sessionId) ?? 0
    updateJobs.set(sourceId, { sessionId, controller })
    const timer = setTimeout(() => controller.abort(), 25_000)
    try {
      const existing = rankMemories(useMemoryState.getState().saved, userText).slice(0, 25)
      const response = await request(`${API_ORIGIN}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-flash',
          thinking: { type: 'disabled' },
          max_tokens: 1000,
          safety_check: { level: 'high' },
          messages: [
            { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
            { role: 'user', content: JSON.stringify({ user: userText.slice(0, 6000), existing }) },
          ],
        }),
      })
      const body = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[]
      }
      const choice = body.choices?.[0]
      if (choice?.finish_reason !== 'stop') {
        throw new Error('memoryExtractionIncomplete')
      }
      const proposals = parseExtraction(choice.message?.content ?? '', existing, userText)
      if (
        controller.signal.aborted ||
        revision !== startRevision ||
        generation !== (sessionRevisions.get(sessionId) ?? 0) ||
        !enabledAuto() ||
        isMemoryExcluded(sessionId) ||
        !(await chats.loadSession(sessionId))
      ) {
        return 'unchanged'
      }
      let changed = false
      const cancelled = () =>
        controller.signal.aborted ||
        revision !== startRevision ||
        !enabledAuto() ||
        isMemoryExcluded(sessionId)
      for (const id of proposals.forget) {
        if (cancelled()) {
          return 'unchanged'
        }
        await db.deleteMemory(id)
        changed = true
      }
      for (const proposal of proposals.memories) {
        const records = await db.loadMemories()
        if (cancelled()) {
          return 'unchanged'
        }
        const previous = records.find(
          (memory) =>
            memory.id === proposal.replaces ||
            (memory.origin === 'automatic' && memory.key === proposal.key)
        )
        if (
          previous?.origin === 'manual' ||
          records.some((memory) => memory.text.trim() === proposal.text.trim())
        ) {
          continue
        }
        const now = Date.now()
        await db.putMemory({
          id: previous?.id ?? createId(),
          text: proposal.text,
          key: proposal.key,
          origin: 'automatic',
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          sourceSessionId: sessionId,
          sourceMessageId: messageId,
        })
        changed = true
      }
      await db.markProcessed(sourceId)
      await refreshSaved()
      return changed ? 'updated' : 'unchanged'
    } catch (error) {
      if (
        controller.signal.aborted &&
        (revision !== startRevision || !enabledAuto() || isMemoryExcluded(sessionId))
      ) {
        return 'unchanged'
      }
      throw error
    } finally {
      clearTimeout(timer)
      updateJobs.delete(sourceId)
    }
  }
  useMemoryState.setState((state) => ({ updating: state.updating + 1 }))
  const task = updateQueue
    .catch(() => {})
    .then(run)
    .finally(() =>
      useMemoryState.setState((state) => ({ updating: Math.max(0, state.updating - 1) }))
    )
  updateQueue = task
  return task
}

export const exportMemoryFile = async () => {
  await initMemory()
  return new Blob(
    [
      JSON.stringify(
        {
          format: 'ohmy-deepseek-memory',
          version: 1,
          saved: useMemoryState.getState().saved,
          excluded: useMemoryState.getState().excluded,
        },
        null,
        2
      ),
    ],
    { type: 'application/json' }
  )
}

export const importMemoryFile = async (file: File) => {
  await initMemory()
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('memoryInvalidBackup')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error('memoryInvalidBackup')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('memoryInvalidBackup')
  }
  const input = raw as {
    format?: string
    version?: number
    saved?: unknown[]
    excluded?: unknown[]
  }
  if (
    input.format !== 'ohmy-deepseek-memory' ||
    input.version !== 1 ||
    !Array.isArray(input.saved) ||
    (input.excluded !== undefined &&
      (!Array.isArray(input.excluded) ||
        input.excluded.some((id) => typeof id !== 'string' || id.length >= 200)))
  ) {
    throw new Error('memoryInvalidBackup')
  }
  const records = input.saved.map((value): SavedMemory => {
    if (!value || typeof value !== 'object') {
      throw new Error('memoryInvalidBackup')
    }
    const item = value as Partial<SavedMemory>
    if (
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 1000 ||
      looksLikeSecret(item.text)
    ) {
      throw new Error('memoryInvalidBackup')
    }
    const now = Date.now()
    return {
      id: createId(),
      text: item.text.trim(),
      key: `manual.${createId()}`,
      origin: 'manual',
      createdAt: now,
      updatedAt: now,
    }
  })
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  const known = new Set(useMemoryState.getState().saved.map((memory) => memory.text))
  let count = 0
  for (const memory of records) {
    if (!known.has(memory.text)) {
      await db.putMemory(memory)
      known.add(memory.text)
      count++
    }
  }
  for (const id of input.excluded ?? []) {
    if (typeof id === 'string' && id.length < 200) {
      await setSessionMemoryExcluded(id, true)
    }
  }
  await refreshSaved()
  return count
}

/** Cancels pending writes as soon as the user disables memory. */
export const bindMemorySettings = () =>
  useSettings.subscribe((state, previous) => {
    if (!state.memoryEnabled || !state.memoryAuto) {
      revision++
      updateJobs.forEach((job) => job.controller.abort())
    }
    if (
      (!state.memoryEnabled || !state.memoryHistory) &&
      previous.memoryEnabled &&
      previous.memoryHistory
    ) {
      void invalidateMemoryHistory().catch(() => useMemoryState.setState({ error: 'index' }))
    }
    if (
      state.memoryEnabled &&
      state.memoryHistory &&
      (!previous.memoryEnabled || !previous.memoryHistory)
    ) {
      void rebuildHistoryIndex().catch(() => useMemoryState.setState({ error: 'index' }))
    }
  })
