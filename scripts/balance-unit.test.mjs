import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBalance,
  primaryBalance,
  balanceLevel,
  formatBalance,
  DEFAULT_THRESHOLDS,
} from '../src/services/balance/model.ts'
const wallet = (currency = 'CNY', total = '12.50') => ({
  currency,
  total_balance: total,
  granted_balance: '2.50',
  topped_up_balance: '10.00',
})

test('balance schema preserves decimal strings and rejects missing or invalid wallet data', () => {
  assert.equal(
    parseBalance({ is_available: true, balance_infos: [wallet()] }).balance_infos[0].total_balance,
    '12.50'
  )
  for (const balance_infos of [
    [],
    [wallet('EUR')],
    [wallet('CNY', 'NaN')],
    [wallet('CNY', '1e10')],
    [wallet(), wallet()],
    [null],
  ]) {
    assert.throws(() => parseBalance({ is_available: true, balance_infos }))
  }
  assert.throws(() => parseBalance({ balance_infos: [wallet()] }))
})
test('availability overrides amounts; different currencies are never added together', () => {
  assert.equal(
    balanceLevel({ is_available: false, balance_infos: [wallet()] }, DEFAULT_THRESHOLDS),
    'empty'
  )
  assert.equal(
    balanceLevel(
      { is_available: true, balance_infos: [wallet('CNY', '0.01')] },
      DEFAULT_THRESHOLDS
    ),
    'low'
  )
  assert.equal(
    balanceLevel(
      { is_available: true, balance_infos: [wallet('CNY', '0.00'), wallet('USD', '10.00')] },
      DEFAULT_THRESHOLDS
    ),
    'normal'
  )
  assert.equal(
    balanceLevel(
      { is_available: true, balance_infos: [wallet('CNY', '0.00')] },
      DEFAULT_THRESHOLDS
    ),
    'empty'
  )
  assert.equal(balanceLevel(null, DEFAULT_THRESHOLDS), 'unknown')
})
test('summary prefers a usable currency, then the locale preference', () => {
  const data = { is_available: true, balance_infos: [wallet('CNY', '0'), wallet('USD', '20')] }
  assert.equal(primaryBalance(data, 'zh-CN').currency, 'USD')
  assert.equal(
    primaryBalance({ ...data, balance_infos: [wallet('CNY'), wallet('USD')] }, 'zh-CN').currency,
    'CNY'
  )
})
test('a small positive balance never rounds to a misleading zero', () => {
  assert.match(formatBalance('0.000001', 'CNY', 'zh-CN'), /^<.*0\.01$/)
  assert.match(formatBalance('12.50', 'USD', 'en-US'), /12\.50/)
})
