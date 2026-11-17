import type { MemoryExtraction, SavedMemory } from './types.js'

/** Only an unquoted, stand-alone explicit command can clear the saved-memory store. */
export const isForgetAllCommand = (text: string) =>
  /^(?:请)?(?:忘记|忘掉|清空|删除)(?:所有|全部)(?:已保存的?|保存的)?记忆[。！!]?$/u.test(
    text.trim()
  ) ||
  /^(?:please\s+)?(?:forget|clear|delete)\s+all\s+(?:saved\s+)?memor(?:y|ies)[.!]?$/i.test(
    text.trim()
  )

export const looksLikeSecret = (text: string) =>
  /\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{15,}|AKIA[A-Z0-9]{16})\b/i.test(text) ||
  /(?:api[ _-]?key|密码|password|密钥|验证码|身份证|银行卡|private[ _-]?key)\s*(?:[:：=]|是)\s*\S+/i.test(
    text
  )

/** Treat the model's JSON as untrusted proposals, never as executable instructions. */
export const parseExtraction = (
  text: string,
  existing: SavedMemory[],
  userText: string
): MemoryExtraction => {
  if (!text.trim()) {
    throw new Error('Empty memory extraction response')
  }
  const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid memory extraction JSON')
  }
  const input = value as { memories?: unknown; forget?: unknown }
  if (!Array.isArray(input.memories) || !Array.isArray(input.forget)) {
    throw new Error('Missing memory extraction arrays')
  }
  const known = new Map(existing.map((memory) => [memory.id, memory]))
  const memories = input.memories.slice(0, 3).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const memory = item as Record<string, unknown>
    if (typeof memory.text !== 'string' || typeof memory.key !== 'string') {
      return []
    }
    const content = memory.text.trim()
    if (
      !content ||
      content.length > 300 ||
      looksLikeSecret(content) ||
      !/^[a-z0-9_.-]{1,80}$/i.test(memory.key)
    ) {
      return []
    }
    const replaces = typeof memory.replaces === 'string' ? memory.replaces : undefined
    if (replaces && (!known.has(replaces) || known.get(replaces)?.origin === 'manual')) {
      return []
    }
    return [{ text: content, key: memory.key, ...(replaces ? { replaces } : {}) }]
  })
  const explicitForget =
    /^(?:(?:请|麻烦你|帮我|我希望你|please\s+))*(?:忘[记掉]|删[除掉]|不要.{0,8}记住|forget\b|remove\b|delete\b)/i.test(
      userText.trim()
    )
  const forget = explicitForget
    ? input.forget.filter((id): id is string => typeof id === 'string' && known.has(id)).slice(0, 5)
    : []
  const forgottenKeys = new Set(forget.map((id) => known.get(id)?.key))
  return { memories: memories.filter((memory) => !forgottenKeys.has(memory.key)), forget }
}
