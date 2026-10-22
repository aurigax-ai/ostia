import { describe, expect, it } from 'vitest'
import { parseNoNewPrivs, readNoNewPrivs } from './noNewPrivs'

const status = (flag: string): string => `Name:\tostia\nNoNewPrivs:\t${flag}\nSeccomp:\t0\n`

describe('parseNoNewPrivs', () => {
  it('reads 1 as set and 0 as clear', () => {
    expect(parseNoNewPrivs(status('1'))).toBe(true)
    expect(parseNoNewPrivs(status('0'))).toBe(false)
  })

  it('is clear when the line is missing', () => {
    expect(parseNoNewPrivs('Name:\tostia\n')).toBe(false)
  })
})

describe('readNoNewPrivs', () => {
  it('reads /proc/self/status on Linux', () => {
    const paths: string[] = []
    const read = (path: string): string => {
      paths.push(path)
      return status('1')
    }
    expect(readNoNewPrivs('linux', read)).toBe(true)
    expect(paths).toEqual(['/proc/self/status'])
  })

  it('is clear off Linux without reading', () => {
    const read = (): string => {
      throw new Error('read')
    }
    expect(readNoNewPrivs('darwin', read)).toBe(false)
    expect(readNoNewPrivs('win32', read)).toBe(false)
  })

  it('is clear when the file cannot be read', () => {
    expect(
      readNoNewPrivs('linux', () => {
        throw new Error('ENOENT')
      }),
    ).toBe(false)
  })
})
