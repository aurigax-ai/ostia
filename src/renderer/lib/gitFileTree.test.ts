import { describe, expect, it } from 'vitest'
import { type TreeNode, buildFileTree } from './gitFileTree'

type Item = { path: string }

function outline(nodes: TreeNode<Item>[], depth = 0): string[] {
  return nodes.flatMap((n) =>
    n.kind === 'folder'
      ? [`${'  '.repeat(depth)}${n.name}/ (${n.count})`, ...outline(n.children, depth + 1)]
      : [`${'  '.repeat(depth)}${n.name}`],
  )
}

const items = (...paths: string[]): Item[] => paths.map((path) => ({ path }))

describe('buildFileTree', () => {
  it('nests files under their folders with file counts, folders before files', () => {
    const tree = buildFileTree(items('b.txt', 'src/a.ts', 'src/lib/c.ts', 'src/lib/d.ts', 'a.txt'))
    expect(outline(tree)).toEqual([
      'src/ (3)',
      '  lib/ (2)',
      '    c.ts',
      '    d.ts',
      '  a.ts',
      'a.txt',
      'b.txt',
    ])
  })

  it('compacts a chain of single-child folders into one row, like VS Code', () => {
    const tree = buildFileTree(items('src/extensions/git/main.ts', 'src/extensions/git/panel.ts'))
    expect(outline(tree)).toEqual(['src/extensions/git/ (2)', '  main.ts', '  panel.ts'])
    expect(tree[0]).toMatchObject({ kind: 'folder', path: 'src/extensions/git' })
  })

  it('stops compacting where a folder also holds files or several folders', () => {
    const tree = buildFileTree(items('a/b/c/one.ts', 'a/b/two.ts', 'a/b/d/e/three.ts'))
    expect(outline(tree)).toEqual([
      'a/b/ (3)',
      '  c/ (1)',
      '    one.ts',
      '  d/e/ (1)',
      '    three.ts',
      '  two.ts',
    ])
    const ab = tree[0]
    expect(ab.kind === 'folder' && ab.children.map((c) => c.path)).toEqual([
      'a/b/c',
      'a/b/d/e',
      'a/b/two.ts',
    ])
  })

  it('keeps the original item on each file and sorts names naturally', () => {
    const tree = buildFileTree([
      { path: 'f10.txt', tag: 1 },
      { path: 'f2.txt', tag: 2 },
    ])
    expect(tree.map((n) => n.name)).toEqual(['f2.txt', 'f10.txt'])
    expect(tree[0]).toMatchObject({ kind: 'file', item: { tag: 2 } })
  })

  it('returns nothing for no changes', () => {
    expect(buildFileTree([])).toEqual([])
  })
})
