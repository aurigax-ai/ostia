import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyExclusive, moveExclusive } from './exclusiveTransfer'
import { FileOps, copyName, nameProblem, numberedName } from './fileOps'

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

  it('moves entries into a folder, refusing a clash or a folder into itself', async () => {
    const { root, ops } = setup()
    mkdirSync(join(root, 'docs'))
    expect(await ops.move([join(root, 'notes.md')], join(root, 'docs'))).toEqual({
      ok: true,
      paths: [join(root, 'docs', 'notes.md')],
    })
    expect(await ops.move([join(root, 'src')], join(root, 'src'))).toEqual({
      ok: false,
      error: 'into-itself',
    })
    writeFileSync(join(root, 'notes.md'), 'again')
    expect(await ops.move([join(root, 'notes.md')], join(root, 'docs'))).toEqual({
      ok: false,
      error: 'exists',
    })
    expect(readFileSync(join(root, 'docs', 'notes.md'), 'utf8')).toBe('notes')
  })

  it('copies beside the original under a copy name and copies folders whole', async () => {
    const { root, ops } = setup()
    expect(await ops.copy([join(root, 'notes.md'), join(root, 'src')], root)).toEqual({
      ok: true,
      paths: [join(root, 'notes copy.md'), join(root, 'src copy')],
    })
    expect(readFileSync(join(root, 'src copy', 'main.ts'), 'utf8')).toBe('main')
    expect(await ops.copy([join(root, 'src')], join(root, 'src'))).toEqual({
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
    expect(await ops.copy([join(root, 'notes.md')], join(root, 'link'))).toEqual({
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

describe('numberedName', () => {
  it('keeps a free name, then numbers it before the extension', () => {
    const dir = tmp()
    expect(numberedName(dir, 'a.ts')).toBe('a.ts')
    writeFileSync(join(dir, 'a.ts'), '')
    expect(numberedName(dir, 'a.ts')).toBe('a (2).ts')
    writeFileSync(join(dir, 'a (2).ts'), '')
    expect(numberedName(dir, 'a.ts')).toBe('a (3).ts')
    mkdirSync(join(dir, 'docs'))
    expect(numberedName(dir, 'docs')).toBe('docs (2)')
  })
})

describe('FileOps.importInto', () => {
  it('copies a dropped file from outside the roots into a folder and leaves the source', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'report.txt')
    writeFileSync(source, 'from the desktop')
    expect(await ops.importInto([source], join(root, 'src'), false)).toEqual({
      ok: true,
      paths: [join(root, 'src', 'report.txt')],
    })
    expect(readFileSync(join(root, 'src', 'report.txt'), 'utf8')).toBe('from the desktop')
    expect(existsSync(source)).toBe(true)
  })

  it('never overwrites: a clash gets a numbered name and the existing file stays', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'notes.md')
    writeFileSync(source, 'dropped')
    expect(await ops.importInto([source], root, false)).toEqual({
      ok: true,
      paths: [join(root, 'notes (2).md')],
    })
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('notes')
    expect(readFileSync(join(root, 'notes (2).md'), 'utf8')).toBe('dropped')
  })

  it('moves a dropped folder when asked, numbering a clash', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'src')
    mkdirSync(source)
    writeFileSync(join(source, 'b.ts'), 'b')
    expect(await ops.importInto([source], root, true)).toEqual({
      ok: true,
      paths: [join(root, 'src (2)')],
    })
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(root, 'src (2)', 'b.ts'), 'utf8')).toBe('b')
    expect(readFileSync(join(root, 'src', 'main.ts'), 'utf8')).toBe('main')
  })

  it.runIf(existsSync('/dev/shm'))(
    'moves across file systems by copying and sending the source to the trash',
    async () => {
      const { root, ops, trashed } = setup()
      const shm = mkdtempSync(join('/dev/shm', 'ostia-fileops-'))
      dirs.push(shm)
      const source = join(shm, 'far.txt')
      writeFileSync(source, 'far')
      expect(await ops.importInto([source], root, true)).toEqual({
        ok: true,
        paths: [join(root, 'far.txt')],
      })
      expect(readFileSync(join(root, 'far.txt'), 'utf8')).toBe('far')
      expect(trashed).toEqual([source])
    },
  )

  it('refuses a root, a folder into itself, a destination outside the roots and bad input', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'a.txt')
    writeFileSync(source, 'a')
    expect(await ops.importInto([root], join(root, 'src'), false)).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await ops.importInto([outside], outside, false)).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await ops.importInto([join(root, 'src')], join(root, 'src'), false)).toEqual({
      ok: false,
      error: 'into-itself',
    })
    for (const paths of [[], ['a.txt'], [join(outside, 'missing')], 'x', [3]]) {
      expect(await ops.importInto(paths, root, false)).toEqual({ ok: false, error: 'outside' })
    }
    expect(readdirSync(root).sort()).toEqual(['notes.md', 'src'])
  })
})

describe('FileOps transfers never replace and never block', () => {
  it('moves a file, a folder and a link inside the roots and keeps a link a link', async () => {
    const { root, outside, ops } = setup()
    mkdirSync(join(root, 'docs'))
    symlinkSync(outside, join(root, 'link'))
    expect(
      await ops.move(
        [join(root, 'notes.md'), join(root, 'src'), join(root, 'link')],
        join(root, 'docs'),
      ),
    ).toEqual({
      ok: true,
      paths: [
        join(root, 'docs', 'notes.md'),
        join(root, 'docs', 'src'),
        join(root, 'docs', 'link'),
      ],
    })
    expect(readFileSync(join(root, 'docs', 'src', 'main.ts'), 'utf8')).toBe('main')
    expect(readlinkSync(join(root, 'docs', 'link'))).toBe(outside)
    expect(readdirSync(root).sort()).toEqual(['docs'])
  })

  it('refuses a FIFO, a socket or a device dropped from the system', async () => {
    const { root, outside, ops } = setup()
    const socket = join(outside, 's.sock')
    const server = createServer()
    await new Promise<void>((ok) => server.listen(socket, ok))
    try {
      for (const source of [socket, '/dev/null']) {
        expect(await ops.importInto([source], root, false), source).toEqual({
          ok: false,
          error: 'outside',
        })
      }
    } finally {
      await new Promise((ok) => server.close(ok))
    }
    expect(readdirSync(root).sort()).toEqual(['notes.md', 'src'])
  })

  it('refuses a remote destination', async () => {
    const { outside, ops } = setup()
    writeFileSync(join(outside, 'a.txt'), 'a')
    expect(await ops.importInto([join(outside, 'a.txt')], 'remote://host/w', false)).toEqual({
      ok: false,
      error: 'outside',
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'sends a copy that fails partway to the trash and leaves the folder as it was',
    async () => {
      const { root, outside, ops, trashed } = setup()
      const source = join(outside, 'photos')
      mkdirSync(source)
      writeFileSync(join(source, 'a.jpg'), 'a')
      writeFileSync(join(source, 'b.jpg'), 'b')
      chmodSync(join(source, 'b.jpg'), 0)
      try {
        expect(await ops.importInto([source], root, false)).toEqual({
          ok: false,
          error: 'failed',
          paths: [],
        })
      } finally {
        chmodSync(join(source, 'b.jpg'), 0o644)
      }
      expect(trashed).toEqual([join(root, 'photos')])
      expect(readdirSync(root).sort()).toEqual(['notes.md', 'src'])
      expect(existsSync(join(source, 'a.jpg'))).toBe(true)
    },
  )

  it.runIf(existsSync('/dev/shm'))(
    'reports a cross-device move whose original cannot go to the trash as copied, not moved',
    async () => {
      const root = tmp()
      const ops = new FileOps({
        roots: [root],
        trash: async () => {
          throw new Error('no trash')
        },
      })
      const shm = mkdtempSync(join('/dev/shm', 'ostia-fileops-'))
      dirs.push(shm)
      const source = join(shm, 'far.txt')
      writeFileSync(source, 'far')
      expect(await ops.importInto([source], root, true)).toEqual({
        ok: false,
        error: 'not-moved',
        paths: [join(root, 'far.txt')],
      })
      expect(readFileSync(join(root, 'far.txt'), 'utf8')).toBe('far')
      expect(existsSync(source)).toBe(true)
    },
  )
})

describe('exclusive transfers', () => {
  it('never takes a name that appeared after it was picked', async () => {
    const dir = tmp()
    const target = join(dir, 'taken')
    for (const make of [
      () => writeFileSync(join(dir, 'file'), 'new'),
      () => mkdirSync(join(dir, 'folder')),
      () => symlinkSync(dir, join(dir, 'link')),
    ]) {
      make()
    }
    writeFileSync(target, 'theirs')
    for (const source of [join(dir, 'file'), join(dir, 'folder'), join(dir, 'link')]) {
      expect(await moveExclusive(source, target), source).toBe('taken')
      expect(await copyExclusive(source, target, async () => {}), source).toBe('taken')
      expect(existsSync(source)).toBe(true)
    }
    expect(readFileSync(target, 'utf8')).toBe('theirs')
    mkdirSync(join(dir, 'empty'))
    expect(await moveExclusive(join(dir, 'folder'), join(dir, 'empty'))).toBe('taken')
    expect(lstatSync(join(dir, 'folder')).isDirectory()).toBe(true)
  })
})

describe('FileOps.draggable', () => {
  it('hands out a real file or folder inside a root, never a root, a link or a path outside', () => {
    const { root, outside, ops } = setup()
    writeFileSync(join(outside, 'secret'), 's')
    symlinkSync(join(outside, 'secret'), join(root, 'link'))
    expect(ops.draggable(join(root, 'notes.md'))).toBe(join(root, 'notes.md'))
    expect(ops.draggable(join(root, 'src'))).toBe(join(root, 'src'))
    expect(ops.draggable(join(root, 'src', '..', 'notes.md'))).toBe(join(root, 'notes.md'))
    expect(ops.draggable(root)).toBeNull()
    expect(ops.draggable(join(root, 'link'))).toBeNull()
    expect(ops.draggable(join(outside, 'secret'))).toBeNull()
    expect(ops.draggable(join(root, 'missing'))).toBeNull()
    expect(ops.draggable(42)).toBeNull()
  })
})
