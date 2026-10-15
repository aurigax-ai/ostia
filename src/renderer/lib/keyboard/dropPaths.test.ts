import { describe, expect, it } from 'vitest'
import { acceptsPathDrop, pathsAsInput } from './dropPaths'

describe('dropped paths', () => {
  it('accepts files, a Files tree row included, and nothing else', () => {
    expect(acceptsPathDrop(['Files'])).toBe(true)
    expect(acceptsPathDrop(['text/plain'])).toBe(false)
  })

  it('types paths shell-quoted with a trailing space and no Enter', () => {
    expect(pathsAsInput(['/w/a.ts', "/w/it's here.md"])).toBe(`/w/a.ts '/w/it'\\''s here.md' `)
    expect(pathsAsInput([])).toBe('')
  })
})
