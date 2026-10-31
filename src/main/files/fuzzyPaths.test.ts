import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzyPaths'

describe('fuzzyMatch', () => {
  it('matches the query letters in order, ignoring case and spaces', () => {
    const hit = fuzzyMatch('Ed tsx', 'src/renderer/components/Editor.tsx')
    expect(hit).not.toBeNull()
    expect(hit?.positions.map((p) => 'src/renderer/components/Editor.tsx'[p]).join('')).toBe(
      'Edtsx',
    )
  })

  it('does not match when a letter is missing', () => {
    expect(fuzzyMatch('xyz', 'src/main.ts')).toBeNull()
  })

  it('does not match an empty query', () => {
    expect(fuzzyMatch('  ', 'src/main.ts')).toBeNull()
  })
})

describe('fuzzyMatch scores', () => {
  const score = (query: string, path: string): number => fuzzyMatch(query, path)?.score ?? 0

  it('scores a file whose name matches above one that only matches across folders', () => {
    expect(score('main', 'src/extensions/git/main.ts')).toBeGreaterThan(
      score('main', 'src/mx/a/in.ts'),
    )
  })

  it('scores matches at word starts, camelCase included, higher', () => {
    expect(score('fv', 'src/FileView.tsx')).toBeGreaterThan(score('fv', 'src/sofavx.ts'))
  })
})
