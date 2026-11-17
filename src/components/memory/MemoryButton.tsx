import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useMemoryState } from '../../services/memory/engine.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { IconThinkOutline14 } from '../base/icons.js'

export const MemoryButton = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const excluded = useMemoryState((state) =>
    sessionId ? state.excluded.includes(sessionId) : state.nextChatExcluded
  )
  return (
    <IconButton
      size="m"
      icon={<IconThinkOutline14 />}
      aria-pressed={enabled && !excluded}
      tooltip={t(enabled && !excluded ? 'memoryButtonOn' : 'memoryButtonOff')}
      onClick={() => openSettings('memory')}
    />
  )
}
