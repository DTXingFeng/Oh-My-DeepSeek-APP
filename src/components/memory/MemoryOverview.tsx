import { useEffect, useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { setMemoryEnabled, useSettings } from '../../services/settings.js'
import {
  applyReviewedMemoryCorrection,
  clearSavedMemories,
  muteMemories,
  useMemoryState,
} from '../../services/memory/engine.js'
import { buildMemoryOverview } from '../../services/memory/overview-model.js'
import {
  generateMemoryOverview,
  proposeMemoryCorrection,
} from '../../services/memory/overview-service.js'
import type {
  MemoryCorrection,
  OverviewCategory,
  SavedMemory,
} from '../../services/memory/types.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { MemoryActions } from './MemoryActions.js'
import styles from './MemoryOverview.module.css'

const categoryLabels: Record<OverviewCategory, TranslationKey> = {
  background: 'overviewBackground',
  preferences: 'overviewPreferences',
  projects: 'overviewProjects',
  other: 'overviewOther',
}
const categories = Object.keys(categoryLabels) as OverviewCategory[]

export const MemoryOverview = ({
  onEdit,
  onAdd,
}: {
  onEdit: (memory: SavedMemory) => void
  onAdd: () => void
}) => {
  const t = useTranslate()
  const saved = useMemoryState((state) => state.saved)
  const enabled = useSettings((state) => state.memoryEnabled)
  const apiKey = useSettings((state) => state.apiKey)
  const locale = useSettings((state) => state.locale)
  const entries = buildMemoryOverview(saved)
  const muted = saved.filter((memory) => memory.muted)
  const [sources, setSources] = useState<string[] | null>(null)
  const [selection, setSelection] = useState<{ text: string; ids: string[] } | null>(null)
  const [instruction, setInstruction] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [proposal, setProposal] = useState<MemoryCorrection | null>(null)
  const [busy, setBusy] = useState<'generate' | 'correct' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const correctionInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    const capture = () => {
      const value = window.getSelection()
      const text = value?.toString().trim()
      const element = value?.anchorNode?.parentElement?.closest('p[data-overview-ids]')
      if (
        !text ||
        text.length > 1000 ||
        !element ||
        !value?.focusNode ||
        !element.contains(value.focusNode)
      ) {
        return
      }
      const ids = JSON.parse(element.getAttribute('data-overview-ids') ?? '[]') as string[]
      setSelection((previous) =>
        previous?.text === text && previous.ids.join(':') === ids.join(':')
          ? previous
          : { text, ids }
      )
    }
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [])
  const run = async (
    kind: 'generate' | 'correct' | 'save',
    action: (signal: AbortSignal) => Promise<unknown>
  ) => {
    if (busy) {
      return
    }
    const own = new AbortController()
    controller.current = own
    setBusy(kind)
    setError(null)
    try {
      await action(own.signal)
    } catch (cause) {
      if (!own.signal.aborted) {
        const key =
          cause instanceof Error &&
          [
            'memoryOverviewChanged',
            'memoryOverviewTooLarge',
            'memoryOverviewEnable',
            'memoryInvalidContent',
          ].includes(cause.message)
            ? (cause.message as TranslationKey)
            : 'memoryOverviewFailed'
        setError(t(key))
      }
    } finally {
      if (controller.current === own) {
        setBusy(null)
        controller.current = null
      }
    }
  }
  const captureSelection = (element: HTMLElement, ids: string[]) => {
    const value = window.getSelection()
    const text = value?.toString().trim()
    if (
      text &&
      text.length <= 1000 &&
      value?.anchorNode &&
      value.focusNode &&
      element.contains(value.anchorNode) &&
      element.contains(value.focusNode)
    ) {
      setSelection({ text, ids })
    }
  }
  const generatedAt = Math.max(0, ...saved.map((memory) => memory.overview?.generatedAt ?? 0))
  return (
    <>
      <section className={styles.inline} data-memory-overview>
        <div className={styles.header}>
          <div>
            <p>{t('overviewCount', { count: saved.length - muted.length, muted: muted.length })}</p>
            {generatedAt ? (
              <small>
                {t('overviewGeneratedAt', {
                  time: new Date(generatedAt).toLocaleTimeString(locale, {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
              </small>
            ) : null}
          </div>
          <div className={styles.organize}>
            <Button
              size="s"
              variant="outlined"
              disabled={!!busy || !apiKey || !enabled || !entries.length}
              onClick={() =>
                void run('generate', async (signal) => {
                  await generateMemoryOverview(signal)
                  showToast(t('overviewGenerated'))
                })
              }
            >
              {t(busy === 'generate' ? 'overviewGenerating' : 'overviewGenerate')}
            </Button>
            <small>{t('overviewGenerateNote')}</small>
          </div>
        </div>
        {!enabled ? <p className={styles.info}>{t('overviewDisabled')}</p> : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {busy === 'generate' || busy === 'correct' ? (
          <div className={styles.working} role="status">
            {t(busy === 'generate' ? 'overviewGenerating' : 'overviewCorrecting')}
            <button type="button" onClick={() => controller.current?.abort()}>
              {t('overviewCancelTask')}
            </button>
          </div>
        ) : null}
        {!entries.length ? (
          <div className={styles.empty}>
            <p>{t('overviewEmpty')}</p>
            <Button size="s" onClick={onAdd}>
              {t('memoryAdd')}
            </Button>
          </div>
        ) : null}
        {categories.map((category) => {
          const grouped = entries.filter((entry) => entry.category === category)
          return grouped.length ? (
            <section
              key={category}
              className={styles.section}
              aria-label={t(categoryLabels[category])}
            >
              <h3>{t(categoryLabels[category])}</h3>
              {grouped.map((entry) => (
                <article className={styles.entry} key={entry.sourceIds.join(':')}>
                  <div className={styles.entryText}>
                    <p
                      data-overview-ids={JSON.stringify(entry.sourceIds)}
                      onMouseUp={(event) => captureSelection(event.currentTarget, entry.sourceIds)}
                      onKeyUp={(event) => captureSelection(event.currentTarget, entry.sourceIds)}
                    >
                      {entry.text}
                    </p>
                    <div className={styles.entryActions}>
                      <button type="button" onClick={() => setSources(entry.sourceIds)}>
                        {t('overviewSources', { count: entry.sourceIds.length })}
                      </button>
                      <MemoryActions
                        disabled={!!busy}
                        actions={[
                          {
                            label: t('memoryEdit'),
                            onSelect: () => {
                              const item = saved.find((memory) => memory.id === entry.sourceIds[0])
                              if (entry.sourceIds.length === 1 && item) {
                                onEdit(item)
                              } else {
                                setSources(entry.sourceIds)
                              }
                            },
                          },
                          {
                            label: t('overviewMute'),
                            onSelect: () =>
                              void run('save', () => muteMemories(entry.sourceIds, true)),
                          },
                        ]}
                      />{' '}
                      {selection?.ids[0] === entry.sourceIds[0] ? (
                        <button
                          type="button"
                          onClick={() => {
                            setCorrecting(true)
                            requestAnimationFrame(() => correctionInput.current?.focus())
                          }}
                        >
                          {t('overviewCorrectSelection')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </section>
          ) : null
        })}
        <details
          className={styles.correction}
          open={correcting}
          onToggle={(event) => setCorrecting(event.currentTarget.open)}
        >
          <summary>
            {t('memoryCorrectOrAdd')}
            <span aria-hidden="true">＋</span>
          </summary>
          <div className={styles.correctionBody}>
            <h3>{t('overviewCorrectionTitle')}</h3>
            {selection ? (
              <div className={styles.selection}>
                <span>“{selection.text}”</span>
                <button type="button" onClick={() => setSelection(null)}>
                  {t('overviewClearSelection')}
                </button>
              </div>
            ) : null}
            <textarea
              ref={correctionInput}
              aria-label={t('overviewCorrectionTitle')}
              placeholder={t('overviewCorrectionPlaceholder')}
              maxLength={2000}
              value={instruction}
              disabled={!!busy}
              onChange={(event) => {
                setInstruction(event.target.value)
                setProposal(null)
              }}
            />
            <div className={styles.correctionFooter}>
              <small>{t('overviewCost')}</small>
              <Button
                size="s"
                disabled={!!busy || !instruction.trim() || !enabled || !apiKey}
                onClick={() =>
                  void run('correct', async (signal) => {
                    setProposal(
                      await proposeMemoryCorrection(
                        instruction,
                        selection?.ids,
                        selection?.text,
                        signal
                      )
                    )
                  })
                }
              >
                {t('overviewPreviewChanges')}
              </Button>
            </div>
          </div>
        </details>
        {proposal ? (
          <div className={styles.proposal}>
            <h3>{t('overviewReviewChanges')}</h3>
            <p className={styles.help}>{t('overviewChangesNotSaved')}</p>
            {proposal.changes.map((change, index) => (
              <div className={styles.change} key={change.id ?? index}>
                {change.id ? (
                  <>
                    <small>{t('overviewBefore')}</small>
                    <p>{saved.find((memory) => memory.id === change.id)?.text}</p>
                  </>
                ) : null}
                <small>{t(change.id ? 'overviewAfter' : 'overviewAdded')}</small>
                <p>{change.text}</p>
              </div>
            ))}
            {proposal.forget.map((id) => (
              <div className={styles.change} key={id}>
                <small>{t('overviewWillForget')}</small>
                <p>{saved.find((memory) => memory.id === id)?.text}</p>
              </div>
            ))}
            {!proposal.changes.length && !proposal.forget.length ? (
              <p>{t('overviewNoChanges')}</p>
            ) : (
              <div className={styles.buttons}>
                <Button
                  size="s"
                  variant="outlined"
                  disabled={!!busy}
                  onClick={() => setProposal(null)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  size="s"
                  disabled={!!busy}
                  onClick={() =>
                    void run('save', async () => {
                      await applyReviewedMemoryCorrection(proposal)
                      setProposal(null)
                      setInstruction('')
                      setSelection(null)
                      showToast(t('overviewApplied'))
                    })
                  }
                >
                  {t('overviewApplyChanges')}
                </Button>
              </div>
            )}
          </div>
        ) : null}
        {muted.length ? (
          <details className={styles.muted}>
            <summary>{t('overviewMutedCount', { count: muted.length })}</summary>
            <p className={styles.help}>{t('overviewMutedHelp')}</p>
            {muted.map((memory) => (
              <div className={styles.mutedItem} key={memory.id}>
                <p>{memory.text}</p>
                <Button
                  size="s"
                  variant="outlined"
                  disabled={!!busy}
                  onClick={() => void run('save', () => muteMemories([memory.id], false))}
                >
                  {t('overviewRestore')}
                </Button>
              </div>
            ))}
          </details>
        ) : null}
        <details className={styles.more}>
          <summary>{t('overviewMore')}</summary>
          <button
            type="button"
            className={styles.danger}
            disabled={!!busy}
            onClick={() => setDeleting(true)}
          >
            {t('overviewDeleteOff')}
          </button>
        </details>
      </section>
      {sources ? (
        <Modal
          title={t('overviewSourceTitle')}
          closable
          className={styles.sourceDialog}
          mainClassName={styles.dialogMain}
          onClose={() => setSources(null)}
        >
          <p className={styles.help}>{t('overviewSourcesHelp')}</p>
          {saved
            .filter((memory) => sources.includes(memory.id))
            .map((memory) => (
              <div className={styles.source} key={memory.id}>
                <p>{memory.text}</p>
                <small>
                  {t(memory.origin === 'manual' ? 'memoryManual' : 'memoryAutomatic')} ·{' '}
                  {new Date(memory.updatedAt).toLocaleDateString(locale)}
                </small>
                <Button size="s" variant="outlined" onClick={() => onEdit(memory)}>
                  {t('memoryEdit')}
                </Button>
              </div>
            ))}
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t('overviewDeleteOff')}
          onClose={() => {
            if (!busy) {
              setDeleting(false)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={!!busy} onClick={() => setDeleting(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={!!busy}
                onClick={() =>
                  void run('save', async () => {
                    await clearSavedMemories()
                    setMemoryEnabled(false)
                    setDeleting(false)
                    showToast(t('overviewDeletedOff'))
                  })
                }
              >
                {t('overviewDeleteOff')}
              </Button>
            </>
          }
        >
          <p>{t('overviewDeleteOffHelp')}</p>
        </Modal>
      ) : null}
    </>
  )
}
