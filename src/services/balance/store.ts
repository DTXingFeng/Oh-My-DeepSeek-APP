import { create } from 'zustand'
import { ApiError, API_ORIGIN, request } from '../api/client.js'
import { useSettings } from '../settings.js'
import {
  DEFAULT_THRESHOLDS,
  parseBalance,
  type AccountBalance,
  type Currency,
  type Thresholds,
} from './model.js'

type BalanceError = 'auth' | 'network' | 'rate' | 'server' | 'protocol'
const readPreferences = () => {
  let hidden = false
  const thresholds = { ...DEFAULT_THRESHOLDS }
  try {
    hidden = localStorage.getItem('ohmy:balance-hidden') === 'true'
    const stored = JSON.parse(localStorage.getItem('ohmy:balance-thresholds') ?? 'null')
    for (const currency of ['CNY', 'USD'] as const) {
      const value = stored?.[currency]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e7) {
        thresholds[currency] = value
      }
    }
  } catch {
    /* Preferences are optional; balance data is never persisted. */
  }
  return { hidden, thresholds }
}
export const useBalance = create<{
  data: AccountBalance | null
  loading: boolean
  error: BalanceError | null
  updatedAt: number | null
  hidden: boolean
  thresholds: Thresholds
  open: boolean
}>(() => ({
  data: null,
  loading: false,
  error: null,
  updatedAt: null,
  open: false,
  ...readPreferences(),
}))

let generation = 0
let controller: AbortController | undefined
let pending: Promise<void> | undefined
let pendingKey: string | null = null
let lastAttempt = 0
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let usageVersion = 0
let queriedUsageVersion = 0

export const refreshBalance = (force = false): Promise<void> => {
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    return Promise.resolve()
  }
  if (pending && pendingKey === apiKey) {
    return pending
  }
  if (!force && Date.now() - lastAttempt < 60_000) {
    return Promise.resolve()
  }
  const epoch = generation
  const requestUsageVersion = usageVersion
  let succeeded = false
  const ownController = new AbortController()
  controller = ownController
  pendingKey = apiKey
  lastAttempt = Date.now()
  useBalance.setState({ loading: true, error: null })
  const timer = setTimeout(() => ownController.abort(), 15_000)
  const task: Promise<void> = (async () => {
    try {
      const response = await request(`${API_ORIGIN}/user/balance`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ownController.signal,
      })
      let data: AccountBalance
      try {
        data = parseBalance(await response.json())
      } catch {
        throw new Error('protocol')
      }
      if (epoch === generation && useSettings.getState().apiKey === apiKey) {
        succeeded = true
        queriedUsageVersion = requestUsageVersion
        useBalance.setState({ data, updatedAt: Date.now(), error: null })
      }
    } catch (error) {
      if (epoch !== generation || useSettings.getState().apiKey !== apiKey) {
        return
      }
      const kind: BalanceError =
        error instanceof ApiError
          ? [401, 403].includes(error.status ?? 0)
            ? 'auth'
            : error.status === 429
              ? 'rate'
              : error.kind === 'network'
                ? 'network'
                : 'server'
          : ownController.signal.aborted
            ? 'network'
            : 'protocol'
      // Authentication failures cannot keep displaying an old account as valid.
      useBalance.setState({
        error: kind,
        ...(kind === 'auth' ? { data: null, updatedAt: null } : {}),
      })
    } finally {
      clearTimeout(timer)
      if (epoch === generation) {
        useBalance.setState({ loading: false })
      }
      if (epoch === generation && controller === ownController) {
        pending = undefined
        pendingKey = null
        if (succeeded && usageVersion > queriedUsageVersion) {
          armBalanceRefresh()
        }
      }
    }
  })()
  pending = task
  return task
}

/** Debounce chargeable operations; account billing may settle slightly after the response. */
const armBalanceRefresh = () => {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(
    () => {
      refreshTimer = undefined
      if (document.visibilityState === 'visible') {
        void refreshBalance(true)
      }
    },
    Math.max(1800, 5000 - (Date.now() - lastAttempt))
  )
}

export const scheduleBalanceRefresh = () => {
  usageVersion++
  armBalanceRefresh()
}

export const setBalanceHidden = (hidden: boolean) => {
  try {
    localStorage.setItem('ohmy:balance-hidden', String(hidden))
  } catch {
    /* in-memory preference */
  }
  useBalance.setState({ hidden })
}
export const setBalanceThreshold = (currency: Currency, value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > 1e7) {
    return false
  }
  const thresholds = { ...useBalance.getState().thresholds, [currency]: value }
  try {
    localStorage.setItem('ohmy:balance-thresholds', JSON.stringify(thresholds))
  } catch {
    /* in-memory preference */
  }
  useBalance.setState({ thresholds })
  return true
}
export const openBalance = () => {
  useBalance.setState({ open: true })
  void refreshBalance()
}
export const closeBalance = () => useBalance.setState({ open: false })

export const bindBalance = () => {
  const reset = () => {
    generation++
    controller?.abort()
    clearTimeout(refreshTimer)
    pending = undefined
    pendingKey = null
    lastAttempt = 0
    usageVersion = 0
    queriedUsageVersion = 0
    useBalance.setState({ data: null, loading: false, error: null, updatedAt: null })
    void refreshBalance()
  }
  const unsubscribe = useSettings.subscribe((next, previous) => {
    if (next.apiKey !== previous.apiKey) {
      reset()
    }
  })
  const visible = () => {
    if (document.visibilityState === 'visible') {
      void refreshBalance(usageVersion > queriedUsageVersion)
    }
  }
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', visible)
  window.addEventListener('ohmydeepseek-usage', scheduleBalanceRefresh)
  reset()
  return () => {
    unsubscribe()
    generation++
    controller?.abort()
    clearTimeout(refreshTimer)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('online', visible)
    window.removeEventListener('ohmydeepseek-usage', scheduleBalanceRefresh)
  }
}
