import type { MemoryCorrection, OverviewCategory, OverviewEntry, SavedMemory } from './types.js'
import { looksLikeSecret } from './policy.js'

export const memorySnapshot = (saved: SavedMemory[]) =>
  JSON.stringify(
    [...saved]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, text, key, updatedAt, muted }) => [id, text, key, updatedAt, !!muted])
  )
export const sourceSnapshot = (saved: SavedMemory[], ids: string[]) =>
  memorySnapshot(saved.filter((memory) => ids.includes(memory.id)))
const categories: OverviewCategory[] = ['background', 'preferences', 'projects', 'other']
export const categorizeMemory = (memory: SavedMemory): OverviewCategory => {
  const text = `${memory.key} ${memory.text}`
  if (/prefer|response|style|language|喜欢|偏好|回答|简短|语言|称呼|叫我/i.test(text)) {
    return 'preferences'
  }
  if (/project|work|goal|正在|开发|项目|计划|学习|工作/i.test(text)) {
    return 'projects'
  }
  if (/identity|profile|name|住在|居住|我是|我叫|名字|职业|家庭|年龄/i.test(text)) {
    return 'background'
  }
  return 'other'
}

/** A cached paraphrase is valid only while every original fact remains unchanged and unmuted. */
export const buildMemoryOverview = (saved: SavedMemory[]): OverviewEntry[] => {
  const active = saved.filter((memory) => !memory.muted)
  const covered = new Set<string>()
  const entries: OverviewEntry[] = []
  for (const memory of active) {
    const entry = memory.overview
    if (
      !entry ||
      !categories.includes(entry.category) ||
      !Array.isArray(entry.sourceIds) ||
      !entry.sourceIds.length ||
      entry.sourceIds.some((id) => covered.has(id) || !active.some((item) => item.id === id)) ||
      entry.snapshot !== sourceSnapshot(active, entry.sourceIds)
    ) {
      continue
    }
    entries.push({ category: entry.category, text: entry.text, sourceIds: entry.sourceIds })
    entry.sourceIds.forEach((id) => covered.add(id))
  }
  for (const memory of [...active].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!covered.has(memory.id)) {
      entries.push({
        category: categorizeMemory(memory),
        text: memory.text,
        sourceIds: [memory.id],
      })
    }
  }
  return entries.sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category))
}

const readJSON = (text: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memoryOverviewInvalid')
  }
  return value as Record<string, unknown>
}
const safeText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= limit &&
  !looksLikeSecret(value)

export const parseOverview = (text: string, saved: SavedMemory[]): OverviewEntry[] => {
  const input = readJSON(text)
  const known = new Set(saved.filter((memory) => !memory.muted).map((memory) => memory.id))
  const seen = new Set<string>()
  if (!Array.isArray(input.entries) || input.entries.length > 100) {
    throw new Error('memoryOverviewInvalid')
  }
  const entries = input.entries.map((item: unknown): OverviewEntry => {
    if (!item || typeof item !== 'object') {
      throw new Error('memoryOverviewInvalid')
    }
    const entry = item as Partial<OverviewEntry>
    if (
      !categories.includes(entry.category as OverviewCategory) ||
      !safeText(entry.text, 1000) ||
      !Array.isArray(entry.sourceIds) ||
      !entry.sourceIds.length
    ) {
      throw new Error('memoryOverviewInvalid')
    }
    for (const id of entry.sourceIds) {
      if (typeof id !== 'string' || !known.has(id) || seen.has(id)) {
        throw new Error('memoryOverviewInvalid')
      }
      seen.add(id)
    }
    return {
      category: entry.category as OverviewCategory,
      text: entry.text.trim(),
      sourceIds: entry.sourceIds,
    }
  })
  if (seen.size !== known.size) {
    throw new Error('memoryOverviewInvalid')
  }
  return entries
}

/** Model corrections are proposals only; the user reviews exact changes before any write. */
export const parseMemoryCorrection = (
  text: string,
  saved: SavedMemory[],
  snapshot: string
): MemoryCorrection => {
  const input = readJSON(text)
  const known = new Set(saved.map((memory) => memory.id))
  const seen = new Set<string>()
  // Some official model responses omit an empty array; absence must never imply deletion.
  if (input.changes === undefined && input.forget === undefined) {
    throw new Error('memoryOverviewInvalid')
  }
  if (input.changes === undefined) {
    input.changes = []
  }
  if (input.forget === undefined) {
    input.forget = []
  }
  if (
    !Array.isArray(input.changes) ||
    !Array.isArray(input.forget) ||
    input.changes.length + input.forget.length > 12
  ) {
    throw new Error('memoryOverviewInvalid')
  }
  const changes = input.changes.map((item: unknown) => {
    if (!item || typeof item !== 'object') {
      throw new Error('memoryOverviewInvalid')
    }
    const change = item as { id?: unknown; text?: unknown }
    if (
      !safeText(change.text, 1000) ||
      (change.id !== undefined &&
        (typeof change.id !== 'string' || !known.has(change.id) || seen.has(change.id)))
    ) {
      throw new Error('memoryOverviewInvalid')
    }
    if (typeof change.id === 'string') {
      seen.add(change.id)
    }
    return { ...(typeof change.id === 'string' ? { id: change.id } : {}), text: change.text.trim() }
  })
  const forget = input.forget.map((id: unknown) => {
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) {
      throw new Error('memoryOverviewInvalid')
    }
    seen.add(id)
    return id
  })
  return { changes, forget, snapshot }
}

export const isMutedHistory = (
  text: string,
  sessionId: string,
  messageId: string,
  muted: SavedMemory[]
) =>
  muted.some(
    (memory) =>
      (memory.sourceSessionId === sessionId && memory.sourceMessageId === messageId) ||
      (memory.text.length >= 6 && text.includes(memory.text))
  )
