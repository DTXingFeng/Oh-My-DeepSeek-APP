import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  generateHistoryMemories,
  HISTORY_MEMORY_BATCH_SIZES,
  scanHistoryMemories,
  type HistoryMemoryPlan,
} from '../../services/memory/engine.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './HistoryMemoryDialog.module.css'

type BatchSize = (typeof HISTORY_MEMORY_BATCH_SIZES)[number]
type Phase = 'scanning' | 'ready' | 'running' | 'done' | 'stopped' | 'failed'

export const HistoryMemoryDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.memoryEnabled)
  const apiKey = useSettings((state) => state.apiKey)
  const [phase, setPhase] = useState<Phase>('scanning')
  const [plan, setPlan] = useState<HistoryMemoryPlan | null>(null)
  const [size, setSize] = useState<BatchSize>(HISTORY_MEMORY_BATCH_SIZES[0])
  const [scanned, setScanned] = useState({ done: 0, total: 0 })
  const [processed, setProcessed] = useState({ done: 0, changed: 0 })
  const controller = useRef<AbortController>()

  const scan = useCallback(() => {
    controller.current?.abort()
    const own = new AbortController()
    controller.current = own
    setPhase('scanning')
    setScanned({ done: 0, total: 0 })
    setProcessed({ done: 0, changed: 0 })
    setPlan(null)
    void scanHistoryMemories(own.signal, (done, total) => {
      if (!own.signal.aborted) {
        setScanned({ done, total })
      }
    })
      .then((result) => {
        if (!own.signal.aborted) {
          setPlan(result)
          setPhase('ready')
        }
      })
      .catch(() => {
        if (!own.signal.aborted) {
          setPhase('failed')
        }
      })
  }, [])

  useEffect(() => {
    scan()
    return () => controller.current?.abort()
  }, [scan])

  const count = Math.min(size, plan?.turns.length ?? 0)
  const generate = async () => {
    if (phase !== 'ready' || !plan || !count || !enabled || !apiKey) {
      return
    }
    controller.current?.abort()
    const own = new AbortController()
    controller.current = own
    setPhase('running')
    try {
      await generateHistoryMemories(plan, size, own.signal, (done, changed) => {
        setProcessed({ done, changed })
      })
      if (controller.current === own) {
        setPhase('done')
      }
    } catch {
      if (controller.current === own) {
        setPhase(own.signal.aborted ? 'stopped' : 'failed')
      }
    }
  }

  const dismiss = () => {
    if (phase === 'running') {
      controller.current?.abort()
      setPhase('stopped')
    } else {
      onClose()
    }
  }

  return (
    <Modal
      title={t('historyMemoryTitle')}
      closable={phase !== 'running'}
      onClose={dismiss}
      className={styles.dialog}
      footer={
        <>
          <Button variant="outlined" onClick={dismiss}>
            {t(phase === 'running' ? 'overviewCancelTask' : 'close')}
          </Button>
          {phase === 'ready' && count > 0 ? (
            <Button disabled={!enabled || !apiKey} onClick={() => void generate()}>
              {t('historyMemoryStart')}
            </Button>
          ) : null}
          {phase === 'done' || phase === 'stopped' || phase === 'failed' ? (
            <Button onClick={scan}>{t('historyMemoryRescan')}</Button>
          ) : null}
        </>
      }
    >
      <div className={styles.body} data-history-memory-phase={phase}>
        {phase === 'scanning' ? (
          <div role="status">
            {t('historyMemoryScanning', scanned)}
            <progress
              max={Math.max(1, scanned.total)}
              value={scanned.total ? scanned.done : undefined}
              aria-label={t('historyMemoryTitle')}
            />
          </div>
        ) : null}
        {phase === 'ready' && plan ? (
          plan.eligible > 0 ? (
            <>
              <p>
                <strong>{t('historyMemoryEligible', { count: plan.eligible })}</strong>
              </p>
              <p>{t('historyMemoryScope')}</p>
              <label className={styles.batch}>
                {t('historyMemoryBatchSize')}
                <select
                  value={size}
                  onChange={(event) => setSize(Number(event.target.value) as BatchSize)}
                >
                  {HISTORY_MEMORY_BATCH_SIZES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <p className={styles.note}>{t('historyMemoryCost', { count })}</p>
              {!enabled || !apiKey ? <p role="status">{t('historyMemoryEnable')}</p> : null}
            </>
          ) : (
            <p role="status">{t('historyMemoryEmpty')}</p>
          )
        ) : null}
        {phase === 'running' ? (
          <div role="status">
            {t('historyMemoryRunning', { done: processed.done, count })}
            <progress value={processed.done} max={count} aria-label={t('historyMemoryTitle')} />
          </div>
        ) : null}
        {phase === 'done' || phase === 'stopped' || phase === 'failed' ? (
          <div role={phase === 'failed' ? 'alert' : 'status'}>
            <p>
              <strong>
                {t(
                  phase === 'done'
                    ? 'historyMemoryDone'
                    : phase === 'stopped'
                      ? 'historyMemoryStopped'
                      : 'historyMemoryFailed'
                )}
              </strong>
            </p>
            {plan ? <p>{t('historyMemoryResult', processed)}</p> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
