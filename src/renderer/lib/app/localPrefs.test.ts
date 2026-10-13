import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPref, writePref } from './localPrefs'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('readPref', () => {
  it('returns what writePref stored', () => {
    writePref('panel', { files: 0.3 })
    writePref('open', true)

    expect(readPref('panel')).toEqual({ files: 0.3 })
    expect(readPref('open')).toBe(true)
    expect(window.localStorage.getItem('open')).toBe('true')
  })

  it('returns null for a missing or unreadable value', () => {
    window.localStorage.setItem('broken', '{')

    expect(readPref('missing')).toBeNull()
    expect(readPref('broken')).toBeNull()
  })

  it('returns null when storage refuses the read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })

    expect(readPref('open')).toBeNull()
  })
})

describe('writePref', () => {
  it('ignores a storage that refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    expect(() => writePref('open', true)).not.toThrow()
  })
})
