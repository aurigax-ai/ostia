import type { FsEntry } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_NESTING_PATTERNS } from '../settings/fileTreeSettings'
import {
  childPath,
  compactChain,
  excludeMatcher,
  nestEntries,
  nestingRules,
  relativeToRoot,
  sortEntries,
} from './fileTree'

const file = (name: string): FsEntry => ({ name, dir: false })
const dir = (name: string): FsEntry => ({ name, dir: true })
const names = (entries: FsEntry[]): string[] => entries.map((e) => e.name)

describe('relativeToRoot', () => {
  it('strips the root prefix and returns null outside it', () => {
    expect(relativeToRoot('/p/src/a.ts', '/p')).toBe('src/a.ts')
    expect(relativeToRoot('/p/src/a.ts', '/p/')).toBe('src/a.ts')
    expect(relativeToRoot('/px/a.ts', '/p')).toBeNull()
  })
})

describe('excludeMatcher', () => {
  it('matches **/name at any depth, including the root level', () => {
    const hidden = excludeMatcher(['**/node_modules', '**/.git'])
    expect(hidden('/p/node_modules', '/p')).toBe(true)
    expect(hidden('/p/pkg/a/node_modules', '/p')).toBe(true)
    expect(hidden('/p/.git', '/p')).toBe(true)
    expect(hidden('/p/.github', '/p')).toBe(false)
    expect(hidden('/p/src', '/p')).toBe(false)
  })

  it('matches a bare pattern only relative to the tree root, like VS Code', () => {
    const hidden = excludeMatcher(['dist'])
    expect(hidden('/p/dist', '/p')).toBe(true)
    expect(hidden('/p/pkg/dist', '/p')).toBe(false)
  })

  it('matches dotfiles with **/.* and absolute paths literally', () => {
    const hidden = excludeMatcher(['**/.*', '/p/src/generated'])
    expect(hidden('/p/.env', '/p')).toBe(true)
    expect(hidden('/p/src/.eslintrc', '/p')).toBe(true)
    expect(hidden('/p/src/generated', '/p')).toBe(true)
    expect(hidden('/q/src/generated', '/q')).toBe(false)
    expect(hidden('/p/src/index.ts', '/p')).toBe(false)
  })

  it('supports *, ? and {a,b} and ignores blank patterns', () => {
    const hidden = excludeMatcher(['', '**/*.{log,tmp}', '**/cache?'])
    expect(hidden('/p/a/debug.log', '/p')).toBe(true)
    expect(hidden('/p/x.tmp', '/p')).toBe(true)
    expect(hidden('/p/cache1', '/p')).toBe(true)
    expect(hidden('/p/cache12', '/p')).toBe(false)
    expect(hidden('/p/a.ts', '/p')).toBe(false)
  })

  it('never matches with no patterns', () => {
    expect(excludeMatcher([])('/p/.git', '/p')).toBe(false)
  })
})

describe('sortEntries', () => {
  const entries = [
    file('b.ts'),
    dir('zeta'),
    file('a.md'),
    dir('Alpha'),
    file('c.json'),
    file('file10'),
    file('file2'),
  ]

  it('puts folders first, then sorts by name case-insensitively and numerically', () => {
    expect(names(sortEntries(entries, 'foldersFirst', 'name'))).toEqual([
      'Alpha',
      'zeta',
      'a.md',
      'b.ts',
      'c.json',
      'file2',
      'file10',
    ])
  })

  it('interleaves folders and files in mixed order', () => {
    expect(names(sortEntries(entries, 'mixed', 'name'))).toEqual([
      'a.md',
      'Alpha',
      'b.ts',
      'c.json',
      'file2',
      'file10',
      'zeta',
    ])
  })

  it('sorts files by extension then name when sorting by type', () => {
    expect(names(sortEntries(entries, 'foldersFirst', 'type'))).toEqual([
      'Alpha',
      'zeta',
      'file2',
      'file10',
      'c.json',
      'a.md',
      'b.ts',
    ])
  })

  it('does not mutate its input', () => {
    const copy = [...entries]
    sortEntries(entries, 'mixed', 'type')
    expect(entries).toEqual(copy)
  })
})

describe('nestEntries', () => {
  const nest = (list: FsEntry[], patterns: Record<string, string>) =>
    nestEntries(list, nestingRules(patterns)).map(({ entry, nested }) => [
      entry.name,
      names(nested),
    ])

  it('nests exact-name children under an exact-name parent', () => {
    expect(
      nest([file('Cargo.lock'), file('Cargo.toml'), file('README.md')], {
        'Cargo.toml': 'Cargo.lock',
      }),
    ).toEqual([
      ['Cargo.toml', ['Cargo.lock']],
      ['README.md', []],
    ])
  })

  it('substitutes ${capture} from the parent wildcard', () => {
    expect(
      nest([file('a.d.ts'), file('a.test.ts'), file('a.ts'), file('b.test.ts'), file('b.ts')], {
        '*.ts': '${capture}.test.ts, ${capture}.d.ts',
      }),
    ).toEqual([
      ['a.ts', ['a.d.ts', 'a.test.ts']],
      ['b.ts', ['b.test.ts']],
    ])
  })

  it('leaves a child whose parent is missing at the top level', () => {
    expect(nest([file('orphan.test.ts')], { '*.ts': '${capture}.test.ts' })).toEqual([
      ['orphan.test.ts', []],
    ])
  })

  it('supports * in child patterns and ${basename}/${extname}', () => {
    expect(
      nest(
        [
          file('tsconfig.json'),
          file('tsconfig.node.json'),
          file('tsconfig.web.json'),
          file('x.md'),
        ],
        { 'tsconfig.json': 'tsconfig.*.json' },
      ),
    ).toEqual([
      ['tsconfig.json', ['tsconfig.node.json', 'tsconfig.web.json']],
      ['x.md', []],
    ])
    expect(
      nest([file('page.vue'), file('page.vue.css')], { '*.vue': '${basename}.${extname}.css' }),
    ).toEqual([['page.vue', ['page.vue.css']]])
  })

  it('matches names case-insensitively and never nests folders', () => {
    expect(
      nest([dir('package-lock.json'), file('Package.json'), file('pnpm-lock.yaml')], {
        'package.json': 'package-lock.json, pnpm-lock.yaml',
      }),
    ).toEqual([
      ['package-lock.json', []],
      ['Package.json', ['pnpm-lock.yaml']],
    ])
  })

  it('nests only one level deep and never forms a cycle', () => {
    expect(
      nest([file('a.js'), file('a.ts')], { '*.ts': '${capture}.js', '*.js': '${capture}.ts' }),
    ).toEqual([['a.js', ['a.ts']]])
  })

  it('escapes regex characters in names and captures', () => {
    expect(
      nest([file('a+b.ts'), file('a+b.test.ts'), file('aab.test.ts')], {
        '*.ts': '${capture}.test.ts',
      }),
    ).toEqual([
      ['a+b.ts', ['a+b.test.ts']],
      ['aab.test.ts', []],
    ])
  })

  it('ignores parent keys with more than one *', () => {
    expect(nestingRules({ '*.*.ts': 'x', '*.ts': '${capture}.js' })).toHaveLength(1)
  })

  it('groups lockfiles under package.json with the default rules', () => {
    expect(
      nest(
        [file('package.json'), file('pnpm-lock.yaml'), file('pnpm-workspace.yaml'), file('src.ts')],
        DEFAULT_NESTING_PATTERNS,
      ),
    ).toEqual([
      ['package.json', ['pnpm-lock.yaml', 'pnpm-workspace.yaml']],
      ['src.ts', []],
    ])
  })

  it('returns every entry unnested when there are no rules', () => {
    expect(nest([file('a.ts'), file('a.test.ts')], {})).toEqual([
      ['a.ts', []],
      ['a.test.ts', []],
    ])
  })
})

describe('compactChain', () => {
  const tree: Record<string, FsEntry[]> = {
    '/p/src': [dir('main')],
    '/p/src/main': [dir('java')],
    '/p/src/main/java': [dir('com'), file('App.java')],
    '/p/lib': [dir('.git'), dir('core')],
    '/p/lib/core': [file('x.ts')],
    '/p/one': [file('only.txt')],
  }
  const list = async (path: string) => tree[path] ?? []
  const all = (entries: FsEntry[]) => entries

  it('follows single-folder chains and returns the last folder listing', async () => {
    const chain = await compactChain('/p/src', list, all)
    expect(chain.names).toEqual(['main', 'java'])
    expect(chain.path).toBe('/p/src/main/java')
    expect(names(chain.entries)).toEqual(['com', 'App.java'])
  })

  it('stops at a folder whose only child is a file', async () => {
    const chain = await compactChain('/p/one', list, all)
    expect(chain.names).toEqual([])
    expect(chain.path).toBe('/p/one')
  })

  it('counts only visible children, so a hidden sibling does not break the chain', async () => {
    const hideGit = (entries: FsEntry[], path: string) =>
      entries.filter((e) => !excludeMatcher(['**/.git'])(childPath(path, e.name), '/p'))
    const chain = await compactChain('/p/lib', list, hideGit)
    expect(chain.names).toEqual(['core'])
    expect(names(chain.entries)).toEqual(['x.ts'])
    expect(names((await compactChain('/p/lib', list, all)).entries)).toEqual(['.git', 'core'])
  })

  it('stops at the depth limit', async () => {
    const deep = async (path: string) => [dir(`d${path.length}`)]
    const chain = await compactChain('/r', deep, all, 5)
    expect(chain.names).toHaveLength(5)
  })
})
