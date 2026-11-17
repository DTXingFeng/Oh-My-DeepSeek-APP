import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  setMemoryAuto,
  setMemoryEnabled,
  setMemoryHistory,
  useSettings,
} from '../../services/settings.js'
import {
  clearSavedMemories,
  exportMemoryFile,
  forgetMemory,
  importMemoryFile,
  initMemory,
  rebuildHistoryIndex,
  saveMemory,
  setSessionMemoryExcluded,
  useMemoryState,
} from '../../services/memory/engine.js'
import { useChatStore, selectSession } from '../../services/chat/store.js'
import { saveBlob } from '../../services/native.js'
import { closeSettings } from './settingsDialogState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemorySettings.module.css'

export const MemorySettings = () => {
  const t = useTranslate()
  const state = useMemoryState()
  const settings = useSettings()
  const activeId = useChatStore((value) => value.activeId)
  const sessions = useChatStore((value) => value.sessions)
  const [editor, setEditor] = useState<{ id?: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const importInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void initMemory().catch(() => {})
  }, [])
  const excluded = activeId ? state.excluded.includes(activeId) : state.nextChatExcluded
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (cause) {
      setError(
        t(
          cause instanceof Error && cause.message === 'memoryInvalidContent'
            ? 'memoryInvalidContent'
            : cause instanceof Error && cause.message === 'memoryInvalidBackup'
              ? 'memoryInvalidBackup'
              : 'memoryActionFailed'
        )
      )
      return false
    } finally {
      setBusy(false)
    }
  }
  const memories = state.saved.filter((memory) =>
    memory.text.toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <div className={styles.panel}>
      <p className={styles.intro}>{t('memoryIntroduction')}</p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <label className={styles.toggle}>
        <span>
          {t('memoryEnabled')}
          <small>{t('memoryEnabledDescription')}</small>
        </span>
        <input
          type="checkbox"
          aria-label={t('memoryEnabled')}
          checked={settings.memoryEnabled}
          onChange={(event) => setMemoryEnabled(event.target.checked)}
        />
      </label>
      <label className={styles.toggle}>
        <span>
          {t('memoryHistory')}
          <small>{t('memoryHistoryDescription')}</small>
        </span>
        <input
          type="checkbox"
          aria-label={t('memoryHistory')}
          disabled={!settings.memoryEnabled}
          checked={settings.memoryEnabled && settings.memoryHistory}
          onChange={(event) => setMemoryHistory(event.target.checked)}
        />
      </label>
      <label className={styles.toggle}>
        <span>
          {t('memoryAuto')}
          <small>{t('memoryAutoDescription')}</small>
        </span>
        <input
          type="checkbox"
          aria-label={t('memoryAuto')}
          disabled={!settings.memoryEnabled}
          checked={settings.memoryEnabled && settings.memoryAuto}
          onChange={(event) => setMemoryAuto(event.target.checked)}
        />
      </label>
      <label className={styles.toggle}>
        <span>
          {t(activeId ? 'memoryThisChat' : 'memoryNextChat')}
          <small>{t('memoryThisChatDescription')}</small>
        </span>
        <input
          type="checkbox"
          aria-label={t(activeId ? 'memoryThisChat' : 'memoryNextChat')}
          disabled={busy || !state.ready}
          checked={!excluded}
          onChange={(event) =>
            void run(() => setSessionMemoryExcluded(activeId, !event.target.checked))
          }
        />
      </label>
      {settings.memoryEnabled && settings.memoryHistory ? (
        <div className={styles.index} role="status">
          <div>
            {state.indexing
              ? t('memoryIndexing', { done: state.indexed, total: state.total })
              : t('memoryIndexReady', { count: state.indexed })}
          </div>
          {state.indexing ? (
            <progress
              max={Math.max(1, state.total)}
              value={state.indexed}
              aria-label={t('memoryIndexProgress')}
            />
          ) : null}
          <small>{t('memoryIndexLocal')}</small>
          <Button
            size="s"
            variant="outlined"
            disabled={state.indexing || busy}
            onClick={() => void run(() => rebuildHistoryIndex(true))}
          >
            {t('memoryRebuildIndex')}
          </Button>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className={styles.error}>
          {t('memoryStorageFailed')}
        </p>
      ) : null}
      <div className={styles.heading}>
        <h3>{t('memorySavedCount', { count: state.saved.length })}</h3>
        <Button size="s" disabled={busy} onClick={() => setEditor({ text: '' })}>
          {t('memoryAdd')}
        </Button>
      </div>
      <input
        className={styles.search}
        aria-label={t('memorySearch')}
        placeholder={t('memorySearch')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {!state.ready ? (
        <p role="status">{t('memoryLoading')}</p>
      ) : memories.length === 0 ? (
        <p className={styles.intro}>{t(state.saved.length ? 'memoryNoMatch' : 'memoryEmpty')}</p>
      ) : null}
      {memories.map((memory) => (
        <article key={memory.id} className={styles.item}>
          <p>{memory.text}</p>
          <small>
            {t(memory.origin === 'manual' ? 'memoryManual' : 'memoryAutomatic')} ·{' '}
            {new Date(memory.updatedAt).toLocaleDateString(settings.locale)}
          </small>
          <div className={styles.actions}>
            {memory.sourceSessionId &&
            sessions.some((session) => session.id === memory.sourceSessionId) ? (
              <Button
                size="s"
                variant="outlined"
                onClick={() => {
                  closeSettings()
                  selectSession(memory.sourceSessionId ?? '')
                }}
              >
                {t('memoryOpenSource')}
              </Button>
            ) : null}
            <Button
              size="s"
              variant="outlined"
              disabled={busy}
              onClick={() => setEditor({ id: memory.id, text: memory.text })}
            >
              {t('memoryEdit')}
            </Button>
            <Button
              size="s"
              variant="dangerOutlined"
              disabled={busy}
              onClick={() => setDeleting(memory.id)}
            >
              {t('memoryForget')}
            </Button>
          </div>
        </article>
      ))}
      <div className={styles.actions}>
        <Button
          size="s"
          variant="outlined"
          disabled={busy || !state.saved.length}
          onClick={() =>
            void run(async () => {
              await saveBlob('ohmy-deepseek-memories.json', await exportMemoryFile())
            })
          }
        >
          {t('memoryExport')}
        </Button>
        <Button
          size="s"
          variant="outlined"
          disabled={busy}
          onClick={() => importInput.current?.click()}
        >
          {t('memoryImport')}
        </Button>
        <input
          ref={importInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void run(async () => {
                const count = await importMemoryFile(file)
                showToast(t('memoryImported', { count }))
              })
            }
          }}
        />
        <Button
          size="s"
          variant="dangerOutlined"
          disabled={busy || !state.saved.length}
          onClick={() => setDeleting('*')}
        >
          {t('memoryClear')}
        </Button>
      </div>
      <small className={styles.intro}>{t('memoryBackupDescription')}</small>
      {editor ? (
        <Modal
          title={t(editor.id ? 'memoryEdit' : 'memoryAdd')}
          onClose={() => {
            if (!busy) {
              setEditor(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={() => setEditor(null)}>
                {t('cancel')}
              </Button>
              <Button
                disabled={busy || !editor.text.trim()}
                onClick={() =>
                  void run(() => saveMemory(editor.text, editor.id)).then((saved) => {
                    if (saved) {
                      setEditor(null)
                      showToast(t('memorySaved'))
                    }
                  })
                }
              >
                {t(busy ? 'memorySaving' : 'memorySave')}
              </Button>
            </>
          }
        >
          <textarea
            className={styles.editor}
            aria-label={t('memoryContent')}
            placeholder={t('memoryPlaceholder')}
            maxLength={1000}
            value={editor.text}
            onChange={(event) => setEditor({ ...editor, text: event.target.value })}
          />
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t(deleting === '*' ? 'memoryClear' : 'memoryForget')}
          onClose={() => {
            if (!busy) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={busy} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    deleting === '*' ? clearSavedMemories() : forgetMemory(deleting)
                  ).then((done) => {
                    if (done) {
                      setDeleting(null)
                    }
                  })
                }
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          <p>{t('memoryDeleteDescription')}</p>
        </Modal>
      ) : null}
    </div>
  )
}
