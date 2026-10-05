import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rankFiles } from './fuzzy'

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

describe('rankFiles', () => {
  it('puts a file whose name matches ahead of one that only matches across folders', () => {
    const ranked = rankFiles('main', ['src/mx/a/in.ts', 'src/extensions/git/main.ts'], 10)
    expect(ranked[0].path).toBe('src/extensions/git/main.ts')
  })

  it('prefers matches at word starts, camelCase included', () => {
    const ranked = rankFiles('fv', ['src/sofavx.ts', 'src/FileView.tsx'], 10)
    expect(ranked[0].path).toBe('src/FileView.tsx')
  })

  it('prefers the shorter path when two match equally', () => {
    const ranked = rankFiles('index', ['a/b/c/index.ts', 'a/index.ts'], 10)
    expect(ranked.map((h) => h.path)).toEqual(['a/index.ts', 'a/b/c/index.ts'])
  })

  it('returns at most the limit', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `file${i}.ts`)
    expect(rankFiles('file', paths, 5)).toHaveLength(5)
  })
})
