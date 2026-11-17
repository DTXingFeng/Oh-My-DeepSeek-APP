export type Currency = 'CNY' | 'USD'
export type BalanceInfo = {
  currency: Currency
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}
export type AccountBalance = { is_available: boolean; balance_infos: BalanceInfo[] }
export type Thresholds = Record<Currency, number>
export const DEFAULT_THRESHOLDS: Thresholds = { CNY: 5, USD: 1 }

const isAmount = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d{1,16}(?:\.\d{1,16})?$/.test(value)

/** Preserve server decimal strings; never combine different currencies. */
export const parseBalance = (raw: unknown): AccountBalance => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid balance response')
  }
  const body = raw as Partial<AccountBalance>
  if (
    typeof body.is_available !== 'boolean' ||
    !Array.isArray(body.balance_infos) ||
    !body.balance_infos.length
  ) {
    throw new Error('Invalid balance response')
  }
  const currencies = new Set<Currency>()
  const balance_infos = body.balance_infos.map((item) => {
    if (
      !item ||
      !['CNY', 'USD'].includes(item.currency) ||
      currencies.has(item.currency) ||
      !isAmount(item.total_balance) ||
      !isAmount(item.granted_balance) ||
      !isAmount(item.topped_up_balance)
    ) {
      throw new Error('Invalid balance response')
    }
    currencies.add(item.currency)
    return {
      currency: item.currency,
      total_balance: item.total_balance,
      granted_balance: item.granted_balance,
      topped_up_balance: item.topped_up_balance,
    }
  })
  return { is_available: body.is_available, balance_infos }
}

export const primaryBalance = (data: AccountBalance | null, locale: string) => {
  const preferred = locale.startsWith('zh') ? 'CNY' : 'USD'
  const balances = data?.balance_infos ?? []
  const positive = balances.filter((item) => Number(item.total_balance) > 0)
  return (
    positive.find((item) => item.currency === preferred) ??
    positive[0] ??
    balances.find((item) => item.currency === preferred) ??
    balances[0]
  )
}

export const balanceLevel = (data: AccountBalance | null, thresholds: Thresholds) => {
  if (!data) {
    return 'unknown'
  }
  if (!data.is_available || data.balance_infos.every((item) => Number(item.total_balance) <= 0)) {
    return 'empty'
  }
  return data.balance_infos.every((item) => Number(item.total_balance) <= thresholds[item.currency])
    ? 'low'
    : 'normal'
}

export const formatBalance = (amount: string, currency: Currency, locale: string) => {
  const value = Number(amount)
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  if (value !== 0 && Math.abs(value) < 0.01) {
    return `${value < 0 ? '>−' : '<'}${formatter.format(0.01)}`
  }
  return formatter.format(value)
}
