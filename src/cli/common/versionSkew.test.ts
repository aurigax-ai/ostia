import { describe, expect, it } from 'vitest'
import { versionSkewWarning } from './versionSkew'

function marks(initial?: string) {
  let mark = initial
  return {
    read: () => mark,
    write: (next: string) => {
      mark = next
    },
  }
}

describe('versionSkewWarning', () => {
  it('stays quiet when the versions match or one is unknown', () => {
    expect(versionSkewWarning('0.5.13', '0.5.13', marks())).toBeUndefined()
    expect(versionSkewWarning(undefined, '0.5.13', marks())).toBeUndefined()
    expect(versionSkewWarning('0.5.13', null, marks())).toBeUndefined()
  })

  it('warns once for a pair of versions, then again when the pair changes', () => {
    const warned = marks()
    expect(versionSkewWarning('0.5.13-main.12', '0.5.13-main.13', warned)).toBe(
      'ostia: the app runs 0.5.13-main.12, this CLI is 0.5.13-main.13; restart Ostia',
    )
    expect(versionSkewWarning('0.5.13-main.12', '0.5.13-main.13', warned)).toBeUndefined()
    expect(versionSkewWarning('0.5.13-main.14', '0.5.13-main.13', warned)).toContain('main.14')
  })
})
