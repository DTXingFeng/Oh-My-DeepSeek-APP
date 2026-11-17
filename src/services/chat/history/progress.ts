export type ImportProgress = {
  phase: 'reading' | 'validating' | 'indexing' | 'importing' | 'saving'
  completed: number
  total: number
  sessions: number
  images: number
}

export type OnImportProgress = (progress: ImportProgress) => void
