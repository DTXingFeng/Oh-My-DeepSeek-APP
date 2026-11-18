import { getVisibleMessages } from '../chat/branches.js'
import type { Session } from '../chat/types.js'
import { isMutedHistory } from './overview-model.js'
import { isForgetRequest, shouldExtractMemory } from './policy.js'
import type { SavedMemory } from './types.js'

export type HistoryMemoryTurn = { sessionId: string; messageId: string; createdAt: number }

export const historyMemorySourceId = (turn: HistoryMemoryTurn) =>
  `${turn.sessionId}:${turn.messageId}`

export const historyMemoryTurns = (session: Session, muted: SavedMemory[]) => {
  const messages = getVisibleMessages(session)
  return messages.flatMap((message, index) => {
    const reply = messages[index + 1]
    if (
      message.role !== 'user' ||
      reply?.role !== 'assistant' ||
      reply.status !== 'done' ||
      reply.stopReason === 'refusal' ||
      !shouldExtractMemory(message.content) ||
      isForgetRequest(message.content) ||
      isMutedHistory(message.content, session.id, message.id, muted)
    ) {
      return []
    }
    return [
      {
        sessionId: session.id,
        messageId: message.id,
        createdAt: message.createdAt,
        text: message.content,
      },
    ]
  })
}
