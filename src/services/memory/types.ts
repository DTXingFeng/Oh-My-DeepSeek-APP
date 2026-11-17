export type SavedMemory = {
  id: string
  text: string
  key: string
  origin: 'manual' | 'automatic'
  createdAt: number
  updatedAt: number
  sourceSessionId?: string
  sourceMessageId?: string
  muted?: boolean
  overview?: OverviewEntry & { snapshot: string; generatedAt: number }
}

export type OverviewCategory = 'background' | 'preferences' | 'projects' | 'other'
export type OverviewEntry = { category: OverviewCategory; text: string; sourceIds: string[] }
export type MemoryCorrection = {
  changes: { id?: string; text: string }[]
  forget: string[]
  snapshot: string
}

export type MemorySource = {
  id: string
  kind: 'saved' | 'history'
  title: string
  excerpt: string
  sessionId?: string
  messageId?: string
  role?: 'user' | 'assistant'
  updatedAt?: number
}

export type HistoryChunk = {
  id: string
  sessionId: string
  messageId: string
  title: string
  text: string
  role: 'user' | 'assistant'
  createdAt: number
  terms: string[]
}

export type MemoryCatalogEntry = { id: string; fingerprint: string }
export type MemoryMutation = { text: string; key: string; replaces?: string }
export type MemoryExtraction = { memories: MemoryMutation[]; forget: string[] }
