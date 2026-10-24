import { describe, expect, it } from 'vitest'
import { displayNames } from './memberNames'

describe('displayNames', () => {
  it('keeps unique names and numbers duplicates in order, ignoring case and spacing', () => {
    const names = displayNames([
      { userId: 'a', displayName: 'Ali' },
      { userId: 'b', displayName: 'Bee' },
      { userId: 'c', displayName: ' ali ' },
    ])
    expect(names.get('a')).toBe('Ali (1)')
    expect(names.get('b')).toBe('Bee')
    expect(names.get('c')).toBe('ali (2)')
  })
})
