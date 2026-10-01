import { describe, expect, it } from 'vitest'
import { type FileProbe, fileWord, isClaimedWord, parseFileArg, refusalLine } from './fileArgs'

function probe(files: string[]): FileProbe {
  return { cwd: '/w/project', home: '/home/u', isFile: (path) => files.includes(path) }
}

describe('fileWord', () => {
  it('reads a word with a slash, a leading dot or a tilde as a path, existing or not', () => {
    const p = probe([])
    expect(fileWord('/tmp/x.png', p)).toBe('path')
    expect(fileWord('src/main.ts', p)).toBe('path')
    expect(fileWord('./notes', p)).toBe('path')
    expect(fileWord('.env', p)).toBe('path')
    expect(fileWord('~/todo.md', p)).toBe('path')
  })

  it('reads a bare word as a file only when that file exists in the folder', () => {
    const p = probe(['/w/project/README', '/w/project/notes.txt'])
    expect(fileWord('README', p)).toBe('name')
    expect(fileWord('notes.txt', p)).toBe('name')
    expect(fileWord('notes.txt:12', p)).toBe('name')
    expect(fileWord('git', p)).toBeNull()
    expect(fileWord('pane.splitRight', p)).toBeNull()
  })
})

describe('isClaimedWord', () => {
  it('lets an extension id or a registered command win over a file of the same name', () => {
    const claimed = { extensionIds: ['git'], commandIds: ['pane.splitRight'] }
    expect(isClaimedWord('git', claimed)).toBe(true)
    expect(isClaimedWord('pane.splitRight', claimed)).toBe(true)
    expect(isClaimedWord('README', claimed)).toBe(false)
  })
})

describe('parseFileArg', () => {
  it('resolves a relative path against the caller folder and ~ against home', () => {
    const p = probe([])
    expect(parseFileArg('src/a.ts', p)).toEqual({ path: '/w/project/src/a.ts' })
    expect(parseFileArg('../b.ts', p)).toEqual({ path: '/w/b.ts' })
    expect(parseFileArg('/var/log/x.log', p)).toEqual({ path: '/var/log/x.log' })
    expect(parseFileArg('~/todo.md', p)).toEqual({ path: '/home/u/todo.md' })
  })

  it('splits file:line and file:line:col off a path', () => {
    const p = probe(['/w/project/a.ts'])
    expect(parseFileArg('a.ts:12', p)).toEqual({ path: '/w/project/a.ts', line: 12 })
    expect(parseFileArg('a.ts:12:4', p)).toEqual({ path: '/w/project/a.ts', line: 12, column: 4 })
    expect(parseFileArg('/tmp/b.ts:3', p)).toEqual({ path: '/tmp/b.ts', line: 3 })
  })

  it('keeps a colon that belongs to an existing file name', () => {
    const p = probe(['/w/project/log:2'])
    expect(parseFileArg('log:2', p)).toEqual({ path: '/w/project/log:2' })
    expect(parseFileArg('a.ts:0', p)).toEqual({ path: '/w/project/a.ts:0' })
  })
})

describe('refusalLine', () => {
  it('names the path and the reason', () => {
    expect(refusalLine('/tmp/dir', 'directory')).toBe('pine: /tmp/dir: is a directory')
    expect(refusalLine('/etc/x', 'outside-sandbox')).toContain('sandboxed workspace')
  })
})
