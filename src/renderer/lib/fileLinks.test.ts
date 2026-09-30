import { describe, expect, it } from 'vitest'
import { findFileLinks, resolveLinkPath } from './fileLinks'

const paths = (text: string) => findFileLinks(text).map((m) => [m.path, m.line, m.column])

describe('findFileLinks', () => {
  it('finds compiler-style paths with line and column', () => {
    expect(paths('src/app.ts:42:7 - error TS2345')).toEqual([['src/app.ts', 42, 7]])
    expect(paths('  at run (/home/u/p/main.js:10:3)')).toEqual([['/home/u/p/main.js', 10, 3]])
    expect(paths('./lib/util.py:8: warning')).toEqual([['./lib/util.py', 8, undefined]])
  })

  it('finds paths with (line,col) and Python tracebacks', () => {
    expect(paths('Program.cs(12,5): error CS1002')).toEqual([['Program.cs', 12, 5]])
    expect(paths('  File "/srv/app/views.py", line 88, in index')).toEqual([
      ['/srv/app/views.py', 88, undefined],
    ])
  })

  it('finds bare file names with an extension and home-relative paths', () => {
    expect(paths('modified:   README.md')).toEqual([['README.md', undefined, undefined]])
    expect(paths('open ~/notes/todo.txt now')).toEqual([['~/notes/todo.txt', undefined, undefined]])
    expect(paths('../shared/types.ts')).toEqual([['../shared/types.ts', undefined, undefined]])
  })

  it('reports the exact span so the link covers path and position', () => {
    const [m] = findFileLinks('error: src/a.ts:3:9 failed')
    expect('error: src/a.ts:3:9 failed'.slice(m.start, m.end)).toBe('src/a.ts:3:9')
  })

  it('ignores URLs, version numbers, plain words and trailing punctuation', () => {
    expect(paths('see https://example.com/a/b.html')).toEqual([])
    expect(paths('node v20.11.1 and 3.14')).toEqual([])
    expect(paths('hello world')).toEqual([])
    expect(paths('edit (src/index.ts).')).toEqual([['src/index.ts', undefined, undefined]])
  })

  it('does not start a path in the middle of a word', () => {
    expect(paths('user@host.com')).toEqual([])
  })
})

describe('resolveLinkPath', () => {
  it('resolves relative paths against the pane cwd and keeps ~ for main to expand', () => {
    expect(resolveLinkPath('src/a.ts', '/home/u/proj')).toBe('/home/u/proj/src/a.ts')
    expect(resolveLinkPath('../b.ts', '/home/u/proj/sub')).toBe('/home/u/proj/b.ts')
    expect(resolveLinkPath('~/x.md', '/tmp')).toBe('~/x.md')
    expect(resolveLinkPath('a.md', '~/proj')).toBe('~/proj/a.md')
    expect(resolveLinkPath('/etc/./hosts', '/tmp')).toBe('/etc/hosts')
  })
})
