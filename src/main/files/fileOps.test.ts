import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileOps, copyName, nameProblem } from './fileOps'

const dirs: string[] = []

function caseSensitiveTmp(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-fileops-case-'))
  try {
    writeFileSync(join(dir, 'probe'), '')
    return !existsSync(join(dir, 'PROBE'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const CASE_SENSITIVE = caseSensitiveTmp()
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ostia-fileops-'))
  dirs.push(d)
  return d
}

function setup(): { root: string; outside: string; ops: FileOps; trashed: string[] } {
  const root = tmp()
  const outside = tmp()
  const trashed: string[] = []
  const ops = new FileOps({
    roots: [root],
    trash: async (path) => {
      trashed.push(path)
      rmSync(path, { recursive: true, force: true })
    },
  })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'main.ts'), 'main')
  writeFileSync(join(root, 'notes.md'), 'notes')
  return { root, outside, ops, trashed }
}

describe('nameProblem', () => {
  it('refuses empty, dot, separator, NUL, padded and overlong names', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', ' a', 'a ', 'x'.repeat(256), 3]) {
      expect(nameProblem(bad), String(bad)).toBe(true)
    }
    for (const good of ['a.ts', '.env', 'My File (1).md', 'x'.repeat(255)]) {
      expect(nameProblem(good), good).toBe(false)
    }
  })
})

describe('copyName', () => {
  it('adds copy, then a number, before the extension', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.ts'), '')
    expect(copyName(dir, 'a.ts')).toBe('a copy.ts')
    writeFileSync(join(dir, 'a copy.ts'), '')
    expect(copyName(dir, 'a.ts')).toBe('a copy 2.ts')
    expect(copyName(dir, '.env')).toBe('.env copy')
  })
})

describe('FileOps', () => {
  it('creates an empty file and a folder, never over an existing name', () => {
    const { root, ops } = setup()
    expect(ops.create(join(root, 'src'), 'new.ts', 'file')).toEqual({
      ok: true,
      paths: [join(root, 'src', 'new.ts')],
    })
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('')
    expect(ops.create(root, 'lib', 'folder').ok).toBe(true)
    expect(ops.create(root, 'notes.md', 'file')).toEqual({ ok: false, error: 'exists' })
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('notes')
    expect(ops.create(root, '../x', 'file')).toEqual({ ok: false, error: 'invalid-name' })
  })

  it('renames in place and refuses a name another entry has', () => {
    const { root, ops } = setup()
    expect(ops.rename(join(root, 'notes.md'), 'readme.md')).toEqual({
      ok: true,
      paths: [join(root, 'readme.md')],
    })
    expect(ops.rename(join(root, 'readme.md'), 'src')).toEqual({ ok: false, error: 'exists' })
    expect(existsSync(join(root, 'readme.md'))).toBe(true)
  })

  it.skipIf(!CASE_SENSITIVE)('refuses a case-only rename onto a different file', () => {
    const { root, ops } = setup()
    writeFileSync(join(root, 'Notes.md'), 'other')
    expect(ops.rename(join(root, 'notes.md'), 'Notes.md')).toEqual({ ok: false, error: 'exists' })
    expect(readFileSync(join(root, 'Notes.md'), 'utf8')).toBe('other')
  })

  it.skipIf(CASE_SENSITIVE)('renames a file to another case of its own name', () => {
    const { root, ops } = setup()
    expect(ops.rename(join(root, 'notes.md'), 'Notes.md')).toEqual({
      ok: true,
      paths: [join(root, 'Notes.md')],
    })
    expect(readdirSync(root)).toContain('Notes.md')
    expect(readFileSync(join(root, 'Notes.md'), 'utf8')).toBe('notes')
  })

  it('moves entries into a folder, refusing a clash or a folder into itself', () => {
    const { root, ops } = setup()
    mkdirSync(join(root, 'docs'))
    expect(ops.move([join(root, 'notes.md')], join(root, 'docs'))).toEqual({
      ok: true,
      paths: [join(root, 'docs', 'notes.md')],
    })
    expect(ops.move([join(root, 'src')], join(root, 'src'))).toEqual({
      ok: false,
      error: 'into-itself',
    })
    writeFileSync(join(root, 'notes.md'), 'again')
    expect(ops.move([join(root, 'notes.md')], join(root, 'docs'))).toEqual({
      ok: false,
      error: 'exists',
    })
    expect(readFileSync(join(root, 'docs', 'notes.md'), 'utf8')).toBe('notes')
  })

  it('copies beside the original under a copy name and copies folders whole', () => {
    const { root, ops } = setup()
    expect(ops.copy([join(root, 'notes.md'), join(root, 'src')], root)).toEqual({
      ok: true,
      paths: [join(root, 'notes copy.md'), join(root, 'src copy')],
    })
    expect(readFileSync(join(root, 'src copy', 'main.ts'), 'utf8')).toBe('main')
    expect(ops.copy([join(root, 'src')], join(root, 'src'))).toEqual({
      ok: false,
      error: 'into-itself',
    })
  })

  it('moves entries to the trash and never a root', async () => {
    const { root, ops, trashed } = setup()
    expect(await ops.trash([join(root, 'notes.md'), join(root, 'src')])).toEqual({
      ok: true,
      paths: [join(root, 'notes.md'), join(root, 'src')],
    })
    expect(trashed).toEqual([join(root, 'notes.md'), join(root, 'src')])
    expect(await ops.trash([root])).toEqual({ ok: false, error: 'outside' })
    expect(existsSync(root)).toBe(true)
  })

  it('refuses anything outside the roots, also through a symlinked folder', async () => {
    const { root, outside, ops } = setup()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'link'))
    expect(ops.create(outside, 'x', 'file')).toEqual({ ok: false, error: 'outside' })
    expect(ops.create(join(root, 'link'), 'x', 'file')).toEqual({ ok: false, error: 'outside' })
    expect(ops.rename(join(root, 'link', 'secret.txt'), 'y')).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(ops.copy([join(root, 'notes.md')], join(root, 'link'))).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await ops.trash([join(root, 'link', 'secret.txt')])).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true)
    expect(existsSync(join(outside, 'x'))).toBe(false)
  })

  it('renames, moves and trashes a symlink itself, not its target', async () => {
    const { root, outside, ops } = setup()
    symlinkSync(outside, join(root, 'link'))
    expect(ops.rename(join(root, 'link'), 'renamed').ok).toBe(true)
    expect(await ops.trash([join(root, 'renamed')])).toMatchObject({ ok: true })
    expect(existsSync(outside)).toBe(true)
  })
})
