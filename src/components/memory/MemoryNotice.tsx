import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { retryMemoryUpdate, selectSession, useChatStore } from '../../services/chat/store.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from '../settings/MemorySettings.module.css'

export const MemoryNotice = ({
  message,
  sessionId,
}: {
  message: AssistantMessage
  sessionId: string
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const sessions = useChatStore((state) => state.sessions)
  const sources = message.memorySources ?? []
  if (!message.memoryStatus && !message.memoryUpdate) {
    return null
  }
  return (
    <>
      <div className={styles.notice}>
        {message.memoryStatus === 'retrieving' ? (
          <span role="status">{t('memoryRetrieving')}</span>
        ) : null}
        {message.memoryStatus === 'error' ? <span>{t('memoryRetrievalFailed')}</span> : null}
        {message.memoryStatus === 'disabled' ? <span>{t('memoryNotUsed')}</span> : null}
        {sources.length > 0 ? (
          <button type="button" onClick={() => setOpen(true)}>
            {t('memorySources', { count: sources.length })}
          </button>
        ) : null}
        {message.memoryUpdate === 'pending' ? (
          <span role="status">{t('memoryUpdating')}</span>
        ) : null}
        {message.memoryUpdate === 'unchanged' ? <span>{t('memoryNoNewMemory')}</span> : null}
        {message.memoryUpdate === 'updated' ? (
          <button type="button" onClick={() => openSettings('memory')}>
            {t('memoryUpdated')}
          </button>
        ) : null}
        {message.memoryUpdate === 'error' ? (
          <button type="button" onClick={() => retryMemoryUpdate(sessionId, message.id)}>
            {t('memoryUpdateFailedRetry')}
          </button>
        ) : null}
      </div>
      {open ? (
        <Modal
          title={t('memorySourcesTitle')}
          className={styles.sourceDialog}
          closable
          onClose={() => setOpen(false)}
        >
          <p className={styles.intro}>{t('memorySourcesDescription')}</p>
          {sources.map((source) => (
            <article className={styles.item} key={source.id}>
              <strong>{source.kind === 'saved' ? t('memorySavedSource') : source.title}</strong>
              {source.role ? (
                <small>
                  {' '}
                  · {t(source.role === 'user' ? 'memoryUserSource' : 'memoryAssistantSource')}
                </small>
              ) : null}
              <p>{source.excerpt}</p>
              {source.sessionId && sessions.some((session) => session.id === source.sessionId) ? (
                <Button
                  size="s"
                  variant="outlined"
                  onClick={() => {
                    setOpen(false)
                    selectSession(source.sessionId ?? '')
                  }}
                >
                  {t('memoryOpenSource')}
                </Button>
              ) : null}
            </article>
          ))}
        </Modal>
      ) : null}
    </>
  )
}
