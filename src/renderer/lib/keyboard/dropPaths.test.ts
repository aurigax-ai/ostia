import { describe, expect, it } from 'vitest'
import { OSTIA_PATH_MIME, acceptsPathDrop, pathsAsInput } from './dropPaths'

describe('dropped paths', () => {
  it('accepts a tree row or OS files, and nothing else', () => {
    expect(acceptsPathDrop([OSTIA_PATH_MIME, 'text/plain'])).toBe(true)
    expect(acceptsPathDrop(['Files'])).toBe(true)
    expect(acceptsPathDrop(['text/plain'])).toBe(false)
  })

  it('types paths shell-quoted with a trailing space and no Enter', () => {
    expect(pathsAsInput(['/w/a.ts', "/w/it's here.md"])).toBe(`/w/a.ts '/w/it'\\''s here.md' `)
    expect(pathsAsInput([])).toBe('')
  })
})
