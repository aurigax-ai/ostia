import { describe, expect, it } from 'vitest'
import {
  type FileProbe,
  diffRefusalLine,
  fileWord,
  isClaimedWord,
  openTarget,
  parseFileArg,
  placementOf,
  refusalLine,
  revealRefusalLine,
} from './fileArgs'

function probe(files: string[], dirs: string[] = []): FileProbe {
  return {
    cwd: '/w/project',
    home: '/home/u',
    isFile: (path) => files.includes(path),
    isDir: (path) => dirs.includes(path),
  }
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
    expect(refusalLine('/tmp/dir', 'directory')).toBe('ostia: /tmp/dir: is a directory')
    expect(refusalLine('/etc/x', 'outside-sandbox')).toContain('sandboxed workspace')
  })
})

describe('open targets', () => {
  it('lets the opener’s own flags, a lone dash and a URL start the bare form', () => {
    const p = probe([])
    for (const word of ['-', '-b', '--background', '--name', 'https://example.com/']) {
      expect(fileWord(word, p), word).toBe('path')
    }
    expect(fileWord('--json', p)).toBeNull()
    expect(fileWord('-x', p)).toBeNull()
  })

  it('never takes a bare folder name for a target, so an unknown verb stays unknown', () => {
    const p = probe([], ['/w/project/git', '/w/project/src'])
    expect(fileWord('git', p)).toBeNull()
    expect(fileWord('src', p)).toBeNull()
    expect(fileWord('./src', p)).toBe('path')
    expect(fileWord('src/', p)).toBe('path')
    expect(fileWord('.', p)).toBe('path')
  })

  it('sorts each word into a URL, stdin, a folder or a file', () => {
    const p = probe(['/w/project/a.ts'], ['/w/project', '/w/project/src', '/home/u'])
    expect(openTarget('https://example.com/x?y=1', p)).toEqual({
      kind: 'url',
      url: 'https://example.com/x?y=1',
    })
    expect(openTarget('-', p)).toEqual({ kind: 'stdin' })
    expect(openTarget('.', p)).toEqual({ kind: 'folder', path: '/w/project' })
    expect(openTarget('src', p)).toEqual({ kind: 'folder', path: '/w/project/src' })
    expect(openTarget('~', p)).toEqual({ kind: 'folder', path: '/home/u' })
    expect(openTarget('a.ts:3:2', p)).toEqual({
      kind: 'file',
      file: { path: '/w/project/a.ts', line: 3, column: 2 },
    })
    expect(openTarget('example.com', p)).toEqual({
      kind: 'file',
      file: { path: '/w/project/example.com' },
    })
    expect(openTarget('missing', p)).toEqual({ kind: 'file', file: { path: '/w/project/missing' } })
  })

  it('names the folder and why it was not shown', () => {
    expect(revealRefusalLine('/srv/x', 'outside-home')).toBe(
      'ostia: /srv/x: folders show only under the home folder',
    )
    expect(revealRefusalLine('/home/u/x', 'not-found')).toBe('ostia: /home/u/x: no such folder')
    expect(revealRefusalLine('/home/u/x', 'command-failed', 'no window')).toBe(
      'ostia: /home/u/x: no window',
    )
  })
})

describe('placement and wait flags', () => {
  it('lets every opener flag start the bare form', () => {
    const p = probe([])
    for (const word of ['-w', '--wait', '--tab', '--split', '-n', '--new']) {
      expect(fileWord(word, p), word).toBe('path')
    }
  })

  it('reads --tab and --split right|down, and refuses what cannot be combined', () => {
    expect(placementOf({ tab: false, split: undefined, wait: false })).toEqual({
      ok: true,
      placement: undefined,
    })
    expect(placementOf({ tab: true, split: undefined, wait: false })).toEqual({
      ok: true,
      placement: 'tab',
    })
    expect(placementOf({ tab: false, split: 'down', wait: false })).toEqual({
      ok: true,
      placement: 'down',
    })
    expect(placementOf({ tab: false, split: 'left', wait: false }).ok).toBe(false)
    expect(placementOf({ tab: true, split: 'right', wait: false }).ok).toBe(false)
    expect(placementOf({ tab: false, split: 'right', wait: true }).ok).toBe(false)
  })

  it('names the side a diff could not read', () => {
    expect(diffRefusalLine('/a/x.bin', 'binary')).toBe('ostia diff: /a/x.bin: is not a text file')
    expect(diffRefusalLine('/a/x', 'not-found')).toBe('ostia diff: /a/x: no such file')
    expect(diffRefusalLine(undefined, 'invalid-args', 'expected two files')).toBe(
      'ostia diff: expected two files',
    )
  })
})
