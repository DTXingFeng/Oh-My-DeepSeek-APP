import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { request, API_ORIGIN } from '../api/client.js'
import { useSettings } from '../settings.js'
import * as chats from '../chat/db.js'
import { getVisibleMessages } from '../chat/branches.js'
import type { Session } from '../chat/types.js'
import * as db from './db.js'
import {
  isForgetAllCommand,
  looksLikeSecret,
  parseExtraction,
  shouldExtractMemory,
} from './policy.js'
import {
  historyMemorySourceId,
  historyMemoryTurns,
  type HistoryMemoryTurn,
} from './history-source.js'
export { shouldExtractMemory } from './policy.js'
import { rankHistory, rankMemories, tokenize } from './retrieval.js'
import { MEMORY_EXTRACTION_PROMPT, formatMemoryContext } from './prompts.js'
import type {
  HistoryChunk,
  MemorySource,
  SavedMemory,
  MemoryCorrection,
  OverviewEntry,
} from './types.js'
import { isMutedHistory, memorySnapshot, sourceSnapshot } from './overview-model.js'

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
let autoRevision = 0
let indexEpoch = 0
let rebuilding: Promise<void> | undefined
let rebuildingEpoch = 0
let updateQueue: Promise<unknown> = Promise.resolve()
const updateJobs = new Map<
  string,
  { sessionId: string; controller: AbortController; history: boolean }
>()
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

export const applyReviewedMemoryCorrection = async (proposal: MemoryCorrection) => {
  await initMemory()
  const saved = useMemoryState.getState().saved
  if (memorySnapshot(saved) !== proposal.snapshot) {
    throw new Error('memoryOverviewChanged')
  }
  const known = new Map(saved.map((memory) => [memory.id, memory]))
  const now = Date.now()
  const updates = proposal.changes.map((change): SavedMemory => {
    if (
      !change.text.trim() ||
      change.text.length > 1000 ||
      looksLikeSecret(change.text) ||
      (change.id && !known.has(change.id))
    ) {
      throw new Error('memoryInvalidContent')
    }
    const previous = change.id ? known.get(change.id) : undefined
    return {
      id: previous?.id ?? createId(),
      key: previous?.key ?? `manual.${createId()}`,
      text: change.text.trim(),
      origin: 'manual',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(previous?.muted ? { muted: true } : {}),
      ...(previous?.sourceSessionId
        ? { sourceSessionId: previous.sourceSessionId, sourceMessageId: previous.sourceMessageId }
        : {}),
    }
  })
  if (proposal.forget.some((id) => !known.has(id))) {
    throw new Error('memoryOverviewInvalid')
  }
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  await db.updateSavedBatch(updates, proposal.forget, proposal.snapshot)
  await refreshSaved()
}

export const muteMemories = async (ids: string[], muted: boolean) => {
  await initMemory()
  const saved = useMemoryState.getState().saved
  revision++
  updateJobs.forEach((job) => job.controller.abort())
  await db.updateSavedBatch(
    saved.filter((memory) => ids.includes(memory.id)).map((memory) => ({ ...memory, muted })),
    [],
    memorySnapshot(saved)
  )
  await refreshSaved()
}

export const storeMemoryOverview = async (entries: OverviewEntry[], expected: string) => {
  const saved = useMemoryState.getState().saved
  if (memorySnapshot(saved) !== expected) {
    throw new Error('memoryOverviewChanged')
  }
  const updates = saved.map((memory): SavedMemory => {
    const entry = entries.find((item) => item.sourceIds[0] === memory.id)
    return {
      ...memory,
      overview: entry
        ? { ...entry, snapshot: sourceSnapshot(saved, entry.sourceIds), generatedAt: Date.now() }
        : undefined,
    }
  })
  await db.updateSavedBatch(updates, [], expected)
  await refreshSaved()
}

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
    ...(previous?.muted ? { muted: true } : {}),
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

export const cancelPendingMemoryUpdates = () => {
  revision++
  updateJobs.forEach((job) => job.controller.abort())
}

export const invalidateMemoryHistory = async () => {
  indexEpoch++
  cancelPendingMemoryUpdates()
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
  const muted = useMemoryState.getState().saved.filter((memory) => memory.muted)
  for (const memory of rankMemories(
    useMemoryState.getState().saved.filter((memory) => !memory.muted),
    question
  )) {
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
    const available = candidates.filter(
      (chunk) =>
        !isMemoryExcluded(chunk.sessionId) &&
        !isMutedHistory(chunk.text, chunk.sessionId, chunk.messageId, muted)
    )
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
          .saved.some(
            (memory) => memory.id === source.id && memory.text === source.excerpt && !memory.muted
          )
      : enabledHistory() &&
        !isMemoryExcluded(source.sessionId ?? '') &&
        !isMutedHistory(
          source.excerpt,
          source.sessionId ?? '',
          source.messageId ?? '',
          useMemoryState.getState().saved.filter((memory) => memory.muted)
        )
  )
  return {
    sources: valid,
    context: formatMemoryContext(valid),
  }
}

type HistoryExtraction = { turn: HistoryMemoryTurn; signal: AbortSignal; revision: number }
type ExtractionResult = 'updated' | 'unchanged'

export const updateMemoryFromTurn = (
  sessionId: string,
  messageId: string,
  userText: string
): Promise<ExtractionResult> => enqueueMemoryExtraction(sessionId, messageId, userText)

const enqueueMemoryExtraction = (
  sessionId: string,
  messageId: string,
  liveText: string,
  history?: HistoryExtraction
): Promise<ExtractionResult> => {
  const sourceId = `${sessionId}:${messageId}`
  const enqueueRevision = history?.revision ?? revision
  const enqueueAutoRevision = autoRevision
  const enqueueGeneration = sessionRevisions.get(sessionId) ?? 0
  const apiKey = useSettings.getState().apiKey
  const isCurrent = () =>
    revision === enqueueRevision &&
    enqueueGeneration === (sessionRevisions.get(sessionId) ?? 0) &&
    useSettings.getState().apiKey === apiKey &&
    !isMemoryExcluded(sessionId) &&
    (history
      ? useSettings.getState().memoryEnabled && !history.signal.aborted
      : enabledAuto() && autoRevision === enqueueAutoRevision)

  const loadHistoryText = async () => {
    if (!history) {
      return liveText
    }
    const session = await chats.loadSession(sessionId)
    if (!session) {
      return undefined
    }
    return historyMemoryTurns(
      session,
      useMemoryState.getState().saved.filter((memory) => memory.muted)
    ).find((turn) => turn.messageId === messageId && turn.createdAt === history.turn.createdAt)
      ?.text
  }

  const run = async (): Promise<ExtractionResult> => {
    await initMemory()
    if (!isCurrent() || (await db.hasProcessed(sourceId))) {
      return 'unchanged'
    }
    const userText = await loadHistoryText()
    if (
      !userText ||
      !shouldExtractMemory(userText) ||
      (!history && !(await chats.loadSession(sessionId))) ||
      !isCurrent()
    ) {
      return 'unchanged'
    }
    if (!history && isForgetAllCommand(userText)) {
      await clearSavedMemories()
      await db.markProcessed(sourceId)
      return 'updated'
    }
    if (!apiKey) {
      throw new Error('memoryNoApiKey')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    history?.signal.addEventListener('abort', abort, { once: true })
    updateJobs.set(sourceId, { sessionId, controller, history: !!history })
    const timer = setTimeout(abort, 25_000)
    try {
      const existing = rankMemories(
        useMemoryState.getState().saved.filter((memory) => !memory.muted),
        userText
      ).slice(0, 25)
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
            {
              role: 'user',
              content: JSON.stringify({
                user: userText.slice(0, 6000),
                existing: existing.map(({ id, text, key, origin, updatedAt }) => ({
                  id,
                  text,
                  key,
                  origin,
                  updatedAt,
                })),
              }),
            },
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
      const sourceStillValid = history
        ? (await loadHistoryText()) === userText
        : !!(await chats.loadSession(sessionId))
      if (controller.signal.aborted || !sourceStillValid || !isCurrent()) {
        return 'unchanged'
      }

      const saved = await db.loadMemories()
      const removed = history ? [] : proposals.forget
      const records = new Map(
        saved.filter((memory) => !removed.includes(memory.id)).map((memory) => [memory.id, memory])
      )
      const updates = new Map<string, SavedMemory>()
      for (const proposal of proposals.memories) {
        const known = [...records.values()]
        const matching = known.filter(
          (memory) => memory.key === proposal.key || memory.id === proposal.replaces
        )
        if (
          matching.some(
            (memory) =>
              memory.origin === 'manual' ||
              memory.muted ||
              (history && memory.updatedAt > history.turn.createdAt)
          )
        ) {
          continue
        }
        if (known.some((memory) => memory.text.trim() === proposal.text.trim())) {
          continue
        }
        const previous = matching.find((memory) => memory.id === proposal.replaces) ?? matching[0]
        const now = Date.now()
        const memory: SavedMemory = {
          id: previous?.id ?? createId(),
          text: proposal.text,
          key: proposal.key,
          origin: 'automatic',
          createdAt: previous?.createdAt ?? now,
          updatedAt: history?.turn.createdAt ?? now,
          sourceSessionId: sessionId,
          sourceMessageId: messageId,
        }
        records.set(memory.id, memory)
        updates.set(memory.id, memory)
      }
      const committed = await db.commitExtraction(
        [...updates.values()],
        removed,
        sourceId,
        memorySnapshot(saved),
        () => isCurrent() && !controller.signal.aborted
      )
      if (!committed) {
        if (isCurrent()) {
          throw new Error('memoryOverviewChanged')
        }
        return 'unchanged'
      }
      await refreshSaved()
      return updates.size || removed.length ? 'updated' : 'unchanged'
    } catch (error) {
      if (controller.signal.aborted && !isCurrent()) {
        return 'unchanged'
      }
      throw error
    } finally {
      clearTimeout(timer)
      history?.signal.removeEventListener('abort', abort)
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

export const HISTORY_MEMORY_BATCH_SIZES = [10, 25, 50] as const
export type HistoryMemoryPlan = { turns: HistoryMemoryTurn[]; eligible: number; revision: number }

export const scanHistoryMemories = async (
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void
): Promise<HistoryMemoryPlan> => {
  await initMemory()
  const scanRevision = revision
  const summaries = await chats.loadSessionSummaries()
  const processed = new Set(await db.loadProcessedIds())
  const muted = useMemoryState.getState().saved.filter((memory) => memory.muted)
  let turns: HistoryMemoryTurn[] = []
  let eligible = 0
  const max = HISTORY_MEMORY_BATCH_SIZES.at(-1) ?? 50
  for (const [index, summary] of summaries.entries()) {
    if (signal.aborted || revision !== scanRevision) {
      throw new Error('memoryOverviewChanged')
    }
    if (!isMemoryExcluded(summary.id)) {
      const session = await chats.loadSession(summary.id)
      if (session) {
        const next = historyMemoryTurns(session, muted).filter(
          (turn) => !processed.has(historyMemorySourceId(turn))
        )
        eligible += next.length
        turns = turns
          .concat(
            next.map(({ sessionId, messageId, createdAt }) => ({ sessionId, messageId, createdAt }))
          )
          .sort(
            (a, b) =>
              b.createdAt - a.createdAt ||
              historyMemorySourceId(a).localeCompare(historyMemorySourceId(b))
          )
          .slice(0, max)
      }
    }
    onProgress(index + 1, summaries.length)
    if (index % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  if (signal.aborted || revision !== scanRevision) {
    throw new Error('memoryOverviewChanged')
  }
  return { turns, eligible, revision: scanRevision }
}

export const generateHistoryMemories = async (
  plan: HistoryMemoryPlan,
  batchSize: (typeof HISTORY_MEMORY_BATCH_SIZES)[number],
  signal: AbortSignal,
  onProgress: (done: number, changed: number) => void
) => {
  if (!useSettings.getState().apiKey || !useSettings.getState().memoryEnabled) {
    throw new Error('memoryOverviewEnable')
  }
  let done = 0
  let changed = 0
  const verify = () => {
    if (signal.aborted) {
      throw signal.reason
    }
    if (revision !== plan.revision) {
      throw new Error('memoryOverviewChanged')
    }
  }
  verify()
  for (const turn of plan.turns.slice(0, batchSize).reverse()) {
    verify()
    const result = await enqueueMemoryExtraction(turn.sessionId, turn.messageId, '', {
      turn,
      signal,
      revision: plan.revision,
    })
    verify()
    done++
    if (result === 'updated') {
      changed++
    }
    onProgress(done, changed)
  }
}

export const exportMemoryFile = async () => {
  await initMemory()
  return new Blob(
    [
      JSON.stringify(
        {
          format: 'ohmy-deepseek-memory',
          version: 2,
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
    ![1, 2].includes(input.version ?? 0) ||
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
      looksLikeSecret(item.text) ||
      (item.muted !== undefined && typeof item.muted !== 'boolean')
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
      ...(item.muted === true ? { muted: true } : {}),
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
    if (state.apiKey !== previous.apiKey || (!state.memoryEnabled && previous.memoryEnabled)) {
      cancelPendingMemoryUpdates()
    } else if (!state.memoryAuto && previous.memoryAuto) {
      autoRevision++
      for (const job of updateJobs.values()) {
        if (!job.history) {
          job.controller.abort()
        }
      }
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
