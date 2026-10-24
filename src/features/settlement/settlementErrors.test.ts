import { describe, expect, it } from 'vitest'
import en from '../../i18n/en.json'
import zhCN from '../../i18n/zh-CN.json'
import { SETTLEMENT_ERROR_CODES } from './settlementRepository'

describe('settlementError messages', () => {
  it.each([['en', en], ['zh-CN', zhCN]])('has a message for every SettlementErrorCode in %s', (_name, bundle) => {
    const messages = bundle.settlementError as Record<string, string>
    for (const code of SETTLEMENT_ERROR_CODES) expect(messages[code], code).toEqual(expect.any(String))
  })
})
