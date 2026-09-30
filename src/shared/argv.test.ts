import { describe, expect, it } from 'vitest'
import { splitArgs } from './argv'

describe('splitArgs', () => {
  it('splits on whitespace and keeps quoted runs as one argument', () => {
    expect(splitArgs(`subl  -w "{file}:{line}" '--flag x'`)).toEqual([
      'subl',
      '-w',
      '{file}:{line}',
      '--flag x',
    ])
  })

  it('returns null for an unbalanced quote', () => {
    expect(splitArgs('code "-g {file}')).toBeNull()
  })

  it('keeps an explicit empty argument', () => {
    expect(splitArgs(`ed "" {file}`)).toEqual(['ed', '', '{file}'])
  })
})
