import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { describe, expect, it } from 'vitest'
import { buildTree, type RawEntry, segmentsOf } from './archiveTree'

function raw(name: string, index: number, extra: Partial<RawEntry> = {}): RawEntry {
  return { name, index, dir: name.endsWith('/'), size: 1, encrypted: false, link: null, ...extra }
}

describe('archiveTree', () => {
  it('splits names into literal segments, escaping control characters and capping depth', () => {
    expect(segmentsOf('/a//./b/../c', BROWSE_LIMITS)).toEqual(['a', 'b', '..', 'c'])
    expect(segmentsOf('tab\there', BROWSE_LIMITS)).toEqual(['tab\\u0009here'])
    expect(segmentsOf('invoice\u202Efdp.exe', BROWSE_LIMITS)).toEqual(['invoice\\u202efdp.exe'])
    expect(segmentsOf('a\u200Fb\u{E0041}c\uD800d', BROWSE_LIMITS)).toEqual([
      'a\\u200fb\\u{e0041}c\\ud800d',
    ])
    const deep = Array.from({ length: 40 }, (_unused, i) => `d${i}`).join('/')
    const parts = segmentsOf(deep, BROWSE_LIMITS)
    expect(parts).toHaveLength(BROWSE_LIMITS.depth)
    expect(parts.at(-1)).toBe(Array.from({ length: 9 }, (_unused, i) => `d${i + 31}`).join('／'))
    expect(segmentsOf('x'.repeat(2_000), BROWSE_LIMITS)[0]).toHaveLength(
      BROWSE_LIMITS.nameLength + 1,
    )
  })

  it('makes folders from paths, keeps duplicate names apart and addresses entries by index', () => {
    const tree = buildTree(
      [raw('a/b.txt', 0), raw('a/b.txt', 1), raw('a', 2), raw('a/c/', 3), raw('top', 4)],
      BROWSE_LIMITS,
    )
    expect(tree.dirs.get('')).toEqual([
      { name: 'a', dir: true },
      { name: 'a (2)', dir: false },
      { name: 'top', dir: false },
    ])
    expect(tree.dirs.get('a')).toEqual([
      { name: 'c', dir: true },
      { name: 'b.txt', dir: false },
      { name: 'b.txt (2)', dir: false },
    ])
    expect(tree.files.get('a/b.txt (2)')?.index).toBe(1)
    expect(tree.files.get('a (2)')?.index).toBe(2)
  })

  it('keeps at most the entry limit', () => {
    const many = Array.from({ length: 30 }, (_unused, i) => raw(`f${i}`, i))
    const tree = buildTree(many, { ...BROWSE_LIMITS, entries: 10 })
    expect(tree.dirs.get('')).toHaveLength(10)
    expect(tree.cut).toBe(true)
  })

  it('marks a tree cut when the provider stopped early, not only past the entry cap', () => {
    expect(buildTree([raw('a', 0)], BROWSE_LIMITS).cut).toBe(false)
    expect(buildTree([raw('a', 0)], BROWSE_LIMITS, true).cut).toBe(true)
  })
})
