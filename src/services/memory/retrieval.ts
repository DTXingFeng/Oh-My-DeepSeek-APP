import type { HistoryChunk, SavedMemory } from './types.js'

const stop = new Set(
  '的 了 是 我 你 他 她 它 我们 你们 这个 那个 一个 什么 怎么 如何 请 可以 还是 以及 但是 因为 所以 之前 以前 上次 记得 the a an and or is are i you my to of in for on it what how please'.split(
    ' '
  )
)
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

/** Chinese words plus character bigrams; English words are kept intact. */
export const tokenize = (text: string): string[] => {
  const result = new Set<string>()
  for (const { segment, isWordLike } of segmenter.segment(text.toLowerCase())) {
    if (!isWordLike || stop.has(segment)) {
      continue
    }
    result.add(segment)
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      for (let index = 0; index + 1 < segment.length; index++) {
        const gram = segment.slice(index, index + 2)
        if (!stop.has(gram)) {
          result.add(gram)
        }
      }
    }
  }
  // ICU boundaries differ by platform. Cross-boundary bigrams keep compounds
  // searchable even when one device splits 像素 into separate characters.
  for (const match of text.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    for (let index = 0; index + 1 < match[0].length; index++) {
      const gram = match[0].slice(index, index + 2)
      if (!stop.has(gram)) {
        result.add(gram)
      }
    }
  }
  return [...result].filter((term) => term.length > 1 || /[\p{Script=Han}]/u.test(term))
}

const overlap = (query: string[], terms: string[]) => {
  const set = new Set(terms)
  return query.reduce((score, term) => score + (set.has(term) ? Math.min(4, term.length) : 0), 0)
}

export const rankMemories = (memories: SavedMemory[], question: string) => {
  const query = tokenize(question)
  return [...memories].sort((left, right) => {
    const score = (memory: SavedMemory) =>
      overlap(query, tokenize(memory.text)) * 20 + (memory.origin === 'manual' ? 3 : 0)
    return score(right) - score(left) || right.updatedAt - left.updatedAt
  })
}

/** Prefer matching rare terms and user statements; cap repeated sources from one chat. */
export const rankHistory = (
  chunks: HistoryChunk[],
  question: string,
  currentSessionId: string,
  now = Date.now()
) => {
  const query = tokenize(question)
  const candidates = chunks.filter((chunk) => chunk.sessionId !== currentSessionId)
  const counts = new Map(
    query.map((term) => [term, candidates.filter((chunk) => chunk.terms.includes(term)).length])
  )
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score:
        query.reduce(
          (score, term) =>
            score +
            (chunk.terms.includes(term)
              ? Math.log(1 + candidates.length / (1 + (counts.get(term) ?? 0))) *
                Math.min(4, term.length)
              : 0),
          0
        ) +
        overlap(query, tokenize(chunk.title)) * 0.5 +
        (chunk.role === 'user' ? 0.2 : 0) +
        0.05 / (1 + Math.max(0, now - chunk.createdAt) / 86_400_000),
    }))
    .filter((item) => overlap(query, item.chunk.terms) > 0)
  scored.sort((a, b) => b.score - a.score || b.chunk.createdAt - a.chunk.createdAt)
  const sessions = new Map<string, number>()
  return scored
    .filter(({ chunk }) => {
      const count = sessions.get(chunk.sessionId) ?? 0
      if (count >= 2) {
        return false
      }
      sessions.set(chunk.sessionId, count + 1)
      return true
    })
    .slice(0, 5)
    .map((item) => item.chunk)
}
