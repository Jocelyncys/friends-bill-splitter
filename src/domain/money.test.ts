import { describe, expect, it } from 'vitest'
import { formatMoney } from './money'

describe('formatMoney', () => {
  it('uses the RM symbol for MYR in both languages', () => {
    expect(formatMoney(8540, 'MYR', 'en')).toMatch(/^RM\s?85\.40$/)
    expect(formatMoney(8540, 'MYR', 'zh-CN')).toMatch(/^RM\s?85\.40$/)
  })
})
