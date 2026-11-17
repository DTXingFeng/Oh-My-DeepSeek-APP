import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  balanceLevel,
  formatBalance,
  primaryBalance,
  type Currency,
} from '../../services/balance/model.js'
import {
  closeBalance,
  openBalance,
  refreshBalance,
  setBalanceHidden,
  setBalanceThreshold,
  useBalance,
} from '../../services/balance/store.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconChevronRightOutline14, IconRefreshOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Button } from '../base/Button.js'
import styles from './Balance.module.css'

const errorKeys = {
  auth: 'balanceErrorAuth',
  network: 'balanceErrorNetwork',
  rate: 'balanceErrorRate',
  server: 'balanceErrorServer',
  protocol: 'balanceErrorProtocol',
} as const

const usePresentation = () => {
  const state = useBalance()
  const apiKey = useSettings((value) => value.apiKey)
  const locale = useSettings((value) => value.locale)
  const t = useTranslate()
  const primary = primaryBalance(state.data, locale)
  const level = balanceLevel(state.data, state.thresholds)
  const statusKey: TranslationKey = !apiKey
    ? 'balanceConnect'
    : state.error
      ? 'balanceUnavailable'
      : state.loading && !state.data
        ? 'balanceLoading'
        : level === 'empty'
          ? 'balanceEmpty'
          : level === 'low'
            ? 'balanceLow'
            : state.data
              ? 'balanceAvailable'
              : 'balanceLoading'
  const amount = state.hidden
    ? '••••'
    : primary
      ? formatBalance(primary.total_balance, primary.currency, locale)
      : '—'
  return { state, apiKey, locale, t, primary, level, status: t(statusKey), amount }
}

export const BalanceSummary = ({ compact = false }: { compact?: boolean }) => {
  const { state, apiKey, t, primary, level, status, amount } = usePresentation()
  const attention = !state.error && (level === 'low' || level === 'empty')
  return (
    <button
      type="button"
      className={clsx(
        compact ? styles.pill : styles.card,
        attention && styles.warning,
        (state.error || !state.data) && styles.failed
      )}
      aria-label={t('balanceOpen', { amount: apiKey ? amount : '', status })}
      onClick={() => {
        if (apiKey) {
          openBalance()
        } else {
          openSettings('data')
        }
      }}
    >
      {compact ? (
        <>
          <span className={styles.dot} aria-hidden="true" />
          <span>{apiKey ? amount : t('balanceConnectShort')}</span>
          {attention ? <span className={styles.pillStatus}>{status}</span> : null}
          {state.error ? <span className={styles.pillStatus}>!</span> : null}
        </>
      ) : (
        <>
          <span className={styles.cardTop}>
            <span>{t('balanceTitle')}</span>
            <span className={styles.status}>
              <span className={styles.dot} aria-hidden="true" />
              {status}
            </span>
          </span>
          <span className={styles.cardAmount}>
            {apiKey ? amount : t('balanceConnectShort')}
            <IconChevronRightOutline14 />
          </span>
          <span className={styles.cardBottom}>
            {primary && !state.hidden ? `${primary.currency} · ` : ''}
            {state.error && state.data ? t('balanceStaleShort') : t('balanceDetailsHint')}
          </span>
        </>
      )}
    </button>
  )
}

/** Detailed view is shared between the sidebar, mobile header, and API key settings. */
export const BalancePanel = () => {
  const { state, apiKey, locale, t, level, status } = usePresentation()
  const [invalidThreshold, setInvalidThreshold] = useState(false)
  const [drafts, setDrafts] = useState<Record<Currency, string>>(() => ({
    CNY: String(state.thresholds.CNY),
    USD: String(state.thresholds.USD),
  }))
  const amount = (value: string, currency: Currency) =>
    state.hidden ? '••••' : formatBalance(value, currency, locale)
  return (
    <section
      className={clsx(
        styles.panel,
        !state.error && (level === 'low' || level === 'empty') && styles.warning
      )}
      aria-label={t('balanceTitle')}
      data-balance-state={
        !apiKey
          ? 'disconnected'
          : state.loading
            ? 'loading'
            : state.error
              ? 'error'
              : state.data
                ? 'ready'
                : 'idle'
      }
    >
      <div className={styles.panelHeader}>
        <span className={styles.eyebrow}>DEEPSEEK API</span>
        <button
          type="button"
          className={styles.textButton}
          aria-pressed={state.hidden}
          onClick={() => setBalanceHidden(!state.hidden)}
        >
          {t(state.hidden ? 'balanceShow' : 'balanceHide')}
        </button>
      </div>
      <div className={styles.panelTitle}>
        <h3>{t('balanceTotal')}</h3>
        <span className={styles.status}>
          <span className={styles.dot} aria-hidden="true" />
          {status}
        </span>
      </div>
      {!apiKey ? (
        <p className={styles.help}>{t('balanceNoKey')}</p>
      ) : state.data ? (
        state.data.balance_infos.map((info) => (
          <div className={styles.wallet} key={info.currency}>
            <div className={styles.total}>
              <span
                className={styles.amount}
                title={state.hidden ? undefined : `${info.total_balance} ${info.currency}`}
              >
                {amount(info.total_balance, info.currency)}
              </span>
              <span className={styles.currency}>{info.currency}</span>
            </div>
            <dl className={styles.breakdown}>
              <div>
                <dt>{t('balanceToppedUp')}</dt>
                <dd>{amount(info.topped_up_balance, info.currency)}</dd>
              </div>
              <div>
                <dt>{t('balanceGranted')}</dt>
                <dd>{amount(info.granted_balance, info.currency)}</dd>
              </div>
            </dl>
          </div>
        ))
      ) : (
        <div className={styles.placeholder} aria-busy={state.loading}>
          <span className={styles.amount}>—</span>
          <span>{t(state.error ? 'balanceUnavailable' : 'balanceLoading')}</span>
        </div>
      )}
      <div className={styles.feedback} role="status" aria-live="polite">
        {state.error ? (
          <p className={styles.error}>
            {t(errorKeys[state.error])}
            {state.data ? ` ${t('balanceStale')}` : ''}
          </p>
        ) : level === 'empty' ? (
          <p className={styles.caution}>{t('balanceEmptyHint')}</p>
        ) : level === 'low' ? (
          <p className={styles.caution}>{t('balanceLowHint')}</p>
        ) : null}
        <span className={styles.timestamp}>
          {state.loading
            ? t('balanceRefreshing')
            : state.updatedAt
              ? t('balanceUpdated', {
                  time: new Date(state.updatedAt).toLocaleTimeString(locale, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }),
                })
              : t('balanceNotQueried')}
        </span>
      </div>
      <div className={styles.actions}>
        {!apiKey || state.error === 'auth' ? (
          <Button
            size="s"
            onClick={() => {
              closeBalance()
              openSettings('data')
            }}
          >
            {t('balanceEditKey')}
          </Button>
        ) : null}
        <Button
          size="s"
          variant="outlined"
          disabled={!apiKey || state.loading}
          onClick={() => void refreshBalance(true)}
        >
          <span className={clsx(styles.refresh, state.loading && styles.spinning)}>
            <IconRefreshOutline16 />
          </span>
          {t(state.loading ? 'balanceRefreshing' : 'balanceRefresh')}
        </Button>
        <a
          className={styles.platformLink}
          href="https://platform.deepseek.com/usage"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('balancePlatform')}
          <span aria-hidden="true">↗</span>
        </a>
      </div>
      <details className={styles.preferences}>
        <summary>{t('balanceWarningSettings')}</summary>
        <p className={styles.help}>{t('balanceThresholdHelp')}</p>
        <div className={styles.thresholds}>
          {(['CNY', 'USD'] as const).map((currency) => (
            <label key={currency}>
              {currency}
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max="10000000"
                aria-label={t('balanceThresholdLabel', { currency })}
                value={drafts[currency]}
                onChange={(event) => setDrafts({ ...drafts, [currency]: event.target.value })}
                onBlur={() => {
                  const text = drafts[currency].trim()
                  const valid = text !== '' && setBalanceThreshold(currency, Number(text))
                  setInvalidThreshold(!valid)
                }}
              />
            </label>
          ))}
        </div>
        {invalidThreshold ? (
          <p className={styles.error} role="alert">
            {t('balanceThresholdInvalid')}
          </p>
        ) : null}
      </details>
      <p className={styles.disclaimer}>{t('balanceDisclaimer')}</p>
    </section>
  )
}

export const BalanceDialog = () => {
  const open = useBalance((state) => state.open)
  const t = useTranslate()
  return open ? (
    <Modal
      title={t('balanceTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.dialogMain}
      onClose={closeBalance}
    >
      <BalancePanel />
    </Modal>
  ) : null
}
