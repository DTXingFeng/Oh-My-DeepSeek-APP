import { openDB, type DBSchema } from 'idb'
import type { HistoryChunk, MemoryCatalogEntry, SavedMemory } from './types.js'
import { memorySnapshot } from './overview-model.js'

/** Independent of the chat database: enabling memory never migrates existing chats. */
interface MemoryDB extends DBSchema {
  saved: { key: string; value: SavedMemory }
  chunks: { key: string; value: HistoryChunk; indexes: { sessionId: string; terms: string } }
  catalog: { key: string; value: MemoryCatalogEntry }
  processed: { key: string; value: { id: string } }
  excluded: { key: string; value: { id: string } }
}
let connection: ReturnType<typeof openMemoryDB> | undefined
const openMemoryDB = () =>
  openDB<MemoryDB>('ohmy-deepseek-memory', 1, {
    upgrade(db) {
      db.createObjectStore('saved', { keyPath: 'id' })
      const chunks = db.createObjectStore('chunks', { keyPath: 'id' })
      chunks.createIndex('sessionId', 'sessionId')
      chunks.createIndex('terms', 'terms', { multiEntry: true })
      db.createObjectStore('catalog', { keyPath: 'id' })
      db.createObjectStore('processed', { keyPath: 'id' })
      db.createObjectStore('excluded', { keyPath: 'id' })
    },
  })
const getDB = () =>
  (connection ??= openMemoryDB().catch((error) => {
    connection = undefined
    throw error
  }))

export const loadMemories = async () => (await getDB()).getAll('saved')
export const putMemory = async (memory: SavedMemory) => (await getDB()).put('saved', memory)
export const updateSavedBatch = async (
  updates: SavedMemory[],
  removed: string[],
  expected: string
) => {
  const tx = (await getDB()).transaction('saved', 'readwrite')
  if (memorySnapshot(await tx.store.getAll()) !== expected) {
    tx.abort()
    await tx.done.catch(() => {})
    throw new Error('memoryOverviewChanged')
  }
  await Promise.all([
    ...removed.map((id) => tx.store.delete(id)),
    ...updates.map((memory) => tx.store.put(memory)),
    tx.done,
  ])
}
export const deleteMemory = async (id: string) => (await getDB()).delete('saved', id)
export const hasProcessed = async (id: string) => !!(await (await getDB()).get('processed', id))
export const markProcessed = async (id: string) => (await getDB()).put('processed', { id })
export const loadProcessedIds = async () => (await getDB()).getAllKeys('processed')

/** Write each turn atomically, including its marker used to resume a history batch. */
export const commitExtraction = async (
  updates: SavedMemory[],
  removed: string[],
  sourceId: string,
  expected: string,
  isCurrent: () => boolean
) => {
  const tx = (await getDB()).transaction(['saved', 'processed'], 'readwrite')
  const saved = tx.objectStore('saved')
  if (memorySnapshot(await saved.getAll()) !== expected || !isCurrent()) {
    tx.abort()
    await tx.done.catch(() => {})
    return false
  }
  await Promise.all([
    ...removed.map((id) => saved.delete(id)),
    ...updates.map((memory) => saved.put(memory)),
    tx.objectStore('processed').put({ id: sourceId }),
    tx.done,
  ])
  return true
}
export const loadExclusions = async () => (await getDB()).getAllKeys('excluded')
export const writeExclusion = async (id: string, excluded: boolean) =>
  excluded ? (await getDB()).put('excluded', { id }) : (await getDB()).delete('excluded', id)
export const loadCatalog = async () => (await getDB()).getAll('catalog')
export const getCatalog = async (id: string) => (await getDB()).get('catalog', id)

export const writeSessionIndex = async (entry: MemoryCatalogEntry, chunks: HistoryChunk[]) => {
  const tx = (await getDB()).transaction(['chunks', 'catalog'], 'readwrite')
  const store = tx.objectStore('chunks')
  const old = await store.index('sessionId').getAllKeys(entry.id)
  await Promise.all([
    ...old.map((id) => store.delete(id)),
    ...chunks.map((chunk) => store.put(chunk)),
    tx.objectStore('catalog').put(entry),
    tx.done,
  ])
}

export const deleteSessionIndex = async (sessionId: string) => {
  const tx = (await getDB()).transaction(['chunks', 'catalog'], 'readwrite')
  const store = tx.objectStore('chunks')
  const ids = await store.index('sessionId').getAllKeys(sessionId)
  await Promise.all([
    ...ids.map((id) => store.delete(id)),
    tx.objectStore('catalog').delete(sessionId),
    tx.done,
  ])
}

export const clearHistoryIndex = async () => {
  const tx = (await getDB()).transaction(['chunks', 'catalog'], 'readwrite')
  await Promise.all([tx.objectStore('chunks').clear(), tx.objectStore('catalog').clear(), tx.done])
}

export const clearMemories = async () => (await getDB()).clear('saved')

/** Read a bounded set of recent postings per term, without loading the whole history. */
export const findHistoryChunks = async (terms: string[]) => {
  const db = await getDB()
  const hits = new Map<string, HistoryChunk>()
  for (const term of terms.slice(0, 20)) {
    const tx = db.transaction('chunks')
    let cursor = await tx.store.index('terms').openCursor(term, 'prev')
    for (let count = 0; cursor && count < 100; count++, cursor = await cursor.continue()) {
      hits.set(cursor.value.id, cursor.value)
    }
    await tx.done
  }
  return [...hits.values()]
}
