import { describe, expect, it } from 'vitest'
import en from './en.json'
import zhCN from './zh-CN.json'

function keys(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [prefix]
  return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
}

describe('i18n resources', () => {
  it('have identical key sets in en and zh-CN', () => {
    expect(keys(zhCN).sort()).toEqual(keys(en).sort())
  })
})
