import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atTransferFs } from './atTransferFs'
import { copyExclusive, moveExclusive } from './exclusiveTransfer'
import { copyName, FileOps, nameProblem, numberedName } from './fileOps'
import { openAnchor } from './folderAnchor'
import { macAt } from './macAt'
import { procAtFs } from './procAtFs'
import { nodeTransferFs, type TransferFs } from './transferFs'

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

const linux = process.platform === 'linux'

const modes: { platform: NodeJS.Platform; base: TransferFs }[] = linux
  ? [
      { platform: 'linux', base: nodeTransferFs },
      { platform: 'darwin', base: atTransferFs(procAtFs) },
    ]
  : [
      {
        platform: process.platform,
        base: process.platform === 'darwin' ? atTransferFs(macAt) : nodeTransferFs,
      },
    ]

function privateTrash(): {
  homeTrash: string
  topdirOf: (path: string) => Promise<string>
  trashAllowedAt: (topdir: string) => Promise<boolean>
} {
  return {
    homeTrash: join(tmp(), 'Trash'),
    topdirOf: async (path) => path,
    trashAllowedAt: async () => true,
  }
}

function setup(): {
  root: string
  outside: string
  ops: FileOps
  trashed: string[]
  homeTrash: string
} {
  const root = tmp()
  const outside = tmp()
  const trashed: string[] = []
  const trash = privateTrash()
  const ops = new FileOps({
    roots: [root],
    ...trash,
    trash: async (path) => {
      trashed.push(path)
      rmSync(path, { recursive: true, force: true })
    },
  })
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'main.ts'), 'main')
  writeFileSync(join(root, 'notes.md'), 'notes')
  return { root, outside, ops, trashed, homeTrash: trash.homeTrash }
}

describe('nameProblem', () => {
  it('refuses empty, dot, separator, NUL, padded and overlong names', async () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', ' a', 'a ', 'x'.repeat(256), 3]) {
      expect(nameProblem(bad), String(bad)).toBe(true)
    }
    for (const good of ['a.ts', '.env', 'My File (1).md', 'x'.repeat(255)]) {
      expect(nameProblem(good), good).toBe(false)
    }
  })
})

describe('copyName', () => {
  it('adds copy, then a number, before the extension', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.ts'), '')
    expect(await copyName(dir, 'a.ts')).toBe('a copy.ts')
    writeFileSync(join(dir, 'a copy.ts'), '')
    expect(await copyName(dir, 'a.ts')).toBe('a copy 2.ts')
    expect(await copyName(dir, '.env')).toBe('.env copy')
  })
})

describe('FileOps', () => {
  it('creates an empty file and a folder, never over an existing name', async () => {
    const { root, ops } = setup()
    expect(await ops.create(join(root, 'src'), 'new.ts', 'file')).toEqual({
      ok: true,
      paths: [join(root, 'src', 'new.ts')],
    })
    expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toBe('')
    expect((await ops.create(root, 'lib', 'folder')).ok).toBe(true)
    expect(await ops.create(root, 'notes.md', 'file')).toEqual({ ok: false, error: 'exists' })
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('notes')
    expect(await ops.create(root, '../x', 'file')).toEqual({ ok: false, error: 'invalid-name' })
  })

  it('renames in place and refuses a name another entry has', async () => {
    const { root, ops } = setup()
    expect(await ops.rename(join(root, 'notes.md'), 'readme.md')).toEqual({
      ok: true,
      paths: [join(root, 'readme.md')],
    })
    expect(await ops.rename(join(root, 'readme.md'), 'src')).toEqual({ ok: false, error: 'exists' })
    expect(existsSync(join(root, 'readme.md'))).toBe(true)
  })

  it.skipIf(!CASE_SENSITIVE)('refuses a case-only rename onto a different file', async () => {
    const { root, ops } = setup()
    writeFileSync(join(root, 'Notes.md'), 'other')
    expect(await ops.rename(join(root, 'notes.md'), 'Notes.md')).toEqual({
      ok: false,
      error: 'exists',
    })
    expect(readFileSync(join(root, 'Notes.md'), 'utf8')).toBe('other')
  })

  it.skipIf(CASE_SENSITIVE)('renames a file to another case of its own name', async () => {
    const { root, ops } = setup()
    expect(await ops.rename(join(root, 'notes.md'), 'Notes.md')).toEqual({
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
    const { root, ops, trashed, homeTrash } = setup()
    expect(await ops.trash([join(root, 'notes.md'), join(root, 'src')])).toEqual({
      ok: true,
      paths: [join(root, 'notes.md'), join(root, 'src')],
    })
    if (linux) {
      expect(trashed).toEqual([])
      expect(readdirSync(join(homeTrash, 'files')).sort()).toEqual(['notes.md', 'src'])
      expect(readFileSync(join(homeTrash, 'files', 'src', 'main.ts'), 'utf8')).toBe('main')
    } else {
      expect(trashed).toEqual([join(root, 'notes.md'), join(root, 'src')])
    }
    expect(await ops.trash([root])).toEqual({ ok: false, error: 'outside' })
    expect(existsSync(root)).toBe(true)
  })

  it('refuses anything outside the roots, also through a symlinked folder', async () => {
    const { root, outside, ops } = setup()
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'link'))
    expect(await ops.create(outside, 'x', 'file')).toEqual({ ok: false, error: 'outside' })
    expect(await ops.create(join(root, 'link'), 'x', 'file')).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await ops.rename(join(root, 'link', 'secret.txt'), 'y')).toEqual({
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
    expect((await ops.rename(join(root, 'link'), 'renamed')).ok).toBe(true)
    expect(await ops.trash([join(root, 'renamed')])).toMatchObject({ ok: true })
    expect(existsSync(outside)).toBe(true)
  })
})

describe('numberedName', () => {
  it('keeps a free name, then numbers it before the extension', async () => {
    const dir = tmp()
    expect(await numberedName(dir, 'a.ts')).toBe('a.ts')
    writeFileSync(join(dir, 'a.ts'), '')
    expect(await numberedName(dir, 'a.ts')).toBe('a (2).ts')
    writeFileSync(join(dir, 'a (2).ts'), '')
    expect(await numberedName(dir, 'a.ts')).toBe('a (3).ts')
    mkdirSync(join(dir, 'docs'))
    expect(await numberedName(dir, 'docs')).toBe('docs (2)')
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

  it('dropping the same file again keeps the first copy and numbers the second', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'report.txt')
    writeFileSync(source, 'first')
    expect(await ops.importInto([source], join(root, 'src'), false)).toEqual({
      ok: true,
      paths: [join(root, 'src', 'report.txt')],
    })
    writeFileSync(source, 'second')
    expect(await ops.importInto([source], join(root, 'src'), false)).toEqual({
      ok: true,
      paths: [join(root, 'src', 'report (2).txt')],
    })
    expect(readFileSync(join(root, 'src', 'report.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(root, 'src', 'report (2).txt'), 'utf8')).toBe('second')
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
      if (linux) {
        expect(trashed).toEqual([])
        const own = join(shm, `.Trash-${process.getuid?.()}`)
        expect(readFileSync(join(own, 'files', 'far.txt'), 'utf8')).toBe('far')
      } else {
        expect(trashed).toEqual([source])
      }
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
    'leaves a copy that fails partway where it is, reports it, and deletes nothing',
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
          error: 'partial',
          paths: [],
          partial: [join(root, 'photos')],
        })
      } finally {
        chmodSync(join(source, 'b.jpg'), 0o644)
      }
      expect(trashed).toEqual([])
      expect(readdirSync(root).sort()).toEqual(['notes.md', 'photos', 'src'])
      expect(existsSync(join(source, 'a.jpg'))).toBe(true)
    },
  )

  it.runIf(existsSync('/dev/shm'))(
    'reports a cross-device move whose original cannot go to the trash as copied, not moved',
    async () => {
      const root = tmp()
      const ops = new FileOps({
        roots: [root],
        homeTrash: join(tmp(), 'Trash'),
        topdirOf: async () => {
          throw new Error('no trash')
        },
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

describe.each(modes)('exclusive transfers on $platform', ({ platform, base }) => {
  const anchored = platform === 'linux' || platform === 'darwin'
  const onLinux = platform === 'linux'
  type Kind = 'open' | 'mkdir' | 'rename'

  function hookedFs(
    kind: Kind,
    name: string,
    when: 'before' | 'after',
    run: () => void,
    fail = false,
  ): TransferFs {
    let fired = false
    const fire = (path: string): void => {
      if (fired || basename(path) !== name) return
      fired = true
      run()
    }
    const wrap =
      <A extends unknown[], R>(k: Kind, call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const path = String(k === 'rename' ? args[1] : args[0])
        if (kind === k && when === 'before') fire(path)
        if (kind === k && fail && basename(path) === name) {
          throw Object.assign(new Error('injected'), { code: 'EIO' })
        }
        const result = await call(...args)
        if (kind === k && when === 'after') fire(path)
        return result
      }
    return {
      ...base,
      open: wrap('open', base.open as (...args: unknown[]) => Promise<never>) as TransferFs['open'],
      mkdir: wrap('mkdir', base.mkdir),
      rename: wrap('rename', base.rename),
    }
  }

  function heldFill(name: string) {
    let release = (): void => {}
    const gate = new Promise<void>((ok) => {
      release = ok
    })
    let reached = (): void => {}
    const holding = new Promise<void>((ok) => {
      reached = ok
    })
    const fs: TransferFs = {
      ...base,
      open: async (path, flags, mode) => {
        const file = await base.open(path, flags, mode)
        if (basename(path) !== name || (flags & constants.O_CREAT) === 0) return file
        const write = file.write.bind(file)
        file.write = (async (...args: Parameters<typeof write>) => {
          reached()
          await gate
          return write(...args)
        }) as typeof file.write
        return file
      },
    }
    return { fs, holding, release }
  }

  function swapForLink(folder: string, to: string): () => void {
    return () => {
      renameSync(folder, `${folder}-real`)
      symlinkSync(to, folder)
    }
  }

  function swapCase(fs: TransferFs) {
    const root = tmp()
    const outside = tmp()
    const far = tmp()
    mkdirSync(join(root, 'drop'))
    const trashed: string[] = []
    const trash = privateTrash()
    const ops = new FileOps({
      roots: [root],
      fs,
      platform,
      ...trash,
      trash: async (path) => {
        trashed.push(path)
        rmSync(path, { recursive: true, force: true })
      },
    })
    return {
      root,
      outside,
      far,
      drop: join(root, 'drop'),
      ops,
      trashed,
      homeTrash: trash.homeTrash,
    }
  }

  it.runIf(anchored)(
    'keeps writing into the real folder when the destination is swapped for a link mid-copy, and deletes nothing',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('open', 'a.jpg', 'after', () => swap()))
      swap = swapForLink(c.drop, c.outside)
      mkdirSync(join(c.outside, 'photos'))
      writeFileSync(join(c.outside, 'photos', 'keep'), 'outside')
      const source = join(c.far, 'photos')
      mkdirSync(source)
      writeFileSync(join(source, 'a.jpg'), 'a')
      writeFileSync(join(source, 'b.jpg'), 'b')
      expect(await c.ops.importInto([source], c.drop, false)).toMatchObject({ ok: true })
      expect(c.trashed).toEqual([])
      expect(readdirSync(join(c.outside, 'photos'))).toEqual(['keep'])
      expect(readdirSync(join(c.root, 'drop-real', 'photos')).sort()).toEqual(['a.jpg', 'b.jpg'])
    },
  )

  it.runIf(anchored)(
    'moves into the real folder when the destination is swapped for a link before the rename',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('open', 'notes.txt', 'after', () => swap()))
      swap = swapForLink(c.drop, c.outside)
      writeFileSync(join(c.outside, 'notes.txt'), 'outside')
      writeFileSync(join(c.far, 'notes.txt'), 'agent')
      expect(await c.ops.importInto([join(c.far, 'notes.txt')], c.drop, true)).toMatchObject({
        ok: true,
      })
      expect(readFileSync(join(c.outside, 'notes.txt'), 'utf8')).toBe('outside')
      expect(readFileSync(join(c.root, 'drop-real', 'notes.txt'), 'utf8')).toBe('agent')
    },
  )

  it.runIf(anchored)(
    'deletes nothing after a failed rename, even when the destination was swapped for a link',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('rename', 'notes.txt', 'before', () => swap(), true))
      swap = swapForLink(c.drop, c.outside)
      writeFileSync(join(c.outside, 'notes.txt'), 'outside')
      writeFileSync(join(c.far, 'notes.txt'), 'agent')
      expect(await c.ops.importInto([join(c.far, 'notes.txt')], c.drop, true)).toMatchObject({
        ok: false,
        error: 'partial',
      })
      expect(readFileSync(join(c.outside, 'notes.txt'), 'utf8')).toBe('outside')
      expect(readFileSync(join(c.far, 'notes.txt'), 'utf8')).toBe('agent')
      expect(c.trashed).toEqual([])
    },
  )

  it.runIf(anchored)(
    'never reads through a source subfolder swapped for a link to secrets',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('mkdir', 'sub', 'after', () => swap()))
      const project = join(c.far, 'project')
      mkdirSync(join(project, 'sub'), { recursive: true })
      writeFileSync(join(project, 'sub', 'ok.txt'), 'ok')
      writeFileSync(join(c.outside, 'id_rsa'), 'secret')
      swap = swapForLink(join(project, 'sub'), c.outside)
      expect(await c.ops.importInto([project], c.drop, false)).toMatchObject({
        ok: false,
        error: 'partial',
      })
      expect(readdirSync(join(c.drop, 'project', 'sub'))).toEqual([])
    },
  )

  it.runIf(anchored)(
    'keeps a folder walk inside the folder it made when that folder is swapped for a link',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('open', 'f.txt', 'before', () => swap()))
      const project = join(c.far, 'project')
      mkdirSync(join(project, 'sub'), { recursive: true })
      writeFileSync(join(project, 'sub', 'f.txt'), 'f')
      swap = (): void => swapForLink(join(c.drop, 'project', 'sub'), c.outside)()
      await c.ops.importInto([project], c.drop, false)
      expect(readdirSync(c.outside)).toEqual([])
    },
  )

  function countingFs(swapAfter: number, swap: () => void): TransferFs {
    let calls = 0
    const counted =
      <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        const result = await call(...args)
        calls += 1
        if (calls === swapAfter) swap()
        return result
      }
    return {
      lstat: counted(base.lstat),
      readdir: counted(base.readdir),
      readlink: counted(base.readlink),
      mkdir: counted(base.mkdir),
      symlink: counted(base.symlink),
      open: counted(base.open as (...args: unknown[]) => Promise<never>) as TransferFs['open'],
      rename: counted(base.rename),
      rmdir: counted(base.rmdir),
      unlink: counted(base.unlink),
    }
  }

  it.runIf(onLinux)(
    'a folder swapped for a link at any step of a Delete never trashes anything outside',
    async () => {
      for (let step = 1; step <= 40; step++) {
        const root = tmp()
        const outside = tmp()
        mkdirSync(join(root, 'sub'))
        writeFileSync(join(root, 'sub', 'notes.md'), 'mine')
        writeFileSync(join(outside, 'notes.md'), 'outside')
        const homeTrash = join(tmp(), 'Trash')
        const trashed: string[] = []
        const ops = new FileOps({
          roots: [root],
          homeTrash,
          topdirOf: async (path) => path,
          fs: countingFs(step, swapForLink(join(root, 'sub'), outside)),
          trash: async (path) => {
            trashed.push(path)
            rmSync(path, { recursive: true })
          },
        })
        const result = await ops.trash([join(root, 'sub', 'notes.md')])
        expect(readFileSync(join(outside, 'notes.md'), 'utf8'), `step ${step}`).toBe('outside')
        expect(trashed, `step ${step}`).toEqual([])
        const inTrash = join(homeTrash, 'files', 'notes.md')
        if (result.ok) expect(readFileSync(inTrash, 'utf8'), `step ${step}`).toBe('mine')
        else expect(existsSync(inTrash), `step ${step}`).toBe(false)
      }
    },
  )

  it.runIf(onLinux)('answers a Delete only with the entry really in the Trash', async () => {
    const root = tmp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'notes.md'), 'mine')
    const homeTrash = join(tmp(), 'Trash')
    const ops = new FileOps({
      roots: [root],
      homeTrash,
      topdirOf: async (path) => path,
      trash: async (path) => {
        renameSync(path, join(root, 'sub', 'kept-by-agent'))
      },
    })
    expect(await ops.trash([join(root, 'sub', 'notes.md')])).toMatchObject({ ok: true })
    expect(readFileSync(join(homeTrash, 'files', 'notes.md'), 'utf8')).toBe('mine')
    expect(readdirSync(join(root, 'sub'))).toEqual([])
  })

  it.runIf(onLinux)(
    'writes a trashinfo with the encoded original path and date, which restores to the original name',
    async () => {
      const { root, ops, homeTrash } = setup()
      const name = 'my notes ü%.md'
      writeFileSync(join(root, 'src', name), 'restore me')
      expect(await ops.trash([join(root, 'src', name)])).toMatchObject({ ok: true })
      const info = readFileSync(join(homeTrash, 'info', `${name}.trashinfo`), 'utf8')
      const lines = info.trimEnd().split('\n')
      expect(lines[0]).toBe('[Trash Info]')
      const encodedRoot = root.split('/').map(encodeURIComponent).join('/')
      expect(lines[1]).toBe(`Path=${encodedRoot}/src/my%20notes%20%C3%BC%25.md`)
      expect(lines[2]).toMatch(/^DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
      const original = decodeURIComponent(lines[1].slice('Path='.length))
      expect(existsSync(original)).toBe(false)
      renameSync(join(homeTrash, 'files', name), original)
      expect(readFileSync(join(root, 'src', name), 'utf8')).toBe('restore me')
    },
  )

  it.runIf(onLinux && existsSync('/dev/shm'))(
    "trashes a source on another device into that device's own trash folder, with a relative path",
    async () => {
      const root = tmp()
      const homeTrash = join(tmp(), 'Trash')
      const shm = mkdtempSync(join('/dev/shm', 'ostia-fileops-'))
      dirs.push(shm)
      writeFileSync(join(shm, 'far.txt'), 'far')
      const trashed: string[] = []
      const ops = new FileOps({
        roots: [root],
        homeTrash,
        topdirOf: async () => shm,
        trashAllowedAt: async () => true,
        trash: async (path) => {
          trashed.push(path)
        },
      })
      expect(await ops.importInto([join(shm, 'far.txt')], root, true)).toMatchObject({ ok: true })
      const own = join(shm, `.Trash-${process.getuid?.()}`)
      expect(trashed).toEqual([])
      expect(readFileSync(join(own, 'files', 'far.txt'), 'utf8')).toBe('far')
      expect(readFileSync(join(own, 'info', 'far.txt.trashinfo'), 'utf8')).toContain(
        '\nPath=far.txt\n',
      )
      expect(existsSync(join(homeTrash, 'files', 'far.txt'))).toBe(false)
    },
  )

  it.runIf(anchored)(
    'refuses a source whose folder was swapped for a link before it was anchored',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('open', 'keys', 'before', () => swap()))
      mkdirSync(join(c.far, 'keys'))
      writeFileSync(join(c.far, 'keys', 'id'), 'agent')
      writeFileSync(join(c.outside, 'id'), 'secret')
      swap = swapForLink(join(c.far, 'keys'), c.outside)
      expect(await c.ops.importInto([join(c.far, 'keys', 'id')], c.drop, false)).toMatchObject({
        ok: false,
        error: 'failed',
      })
      expect(readdirSync(c.drop)).toEqual([])
    },
  )

  it.runIf(anchored)(
    'refuses a source reached through a folder higher up that was swapped for a link',
    async () => {
      let swap = (): void => {}
      const c = swapCase(hookedFs('open', 'b', 'before', () => swap()))
      mkdirSync(join(c.far, 'a', 'b'), { recursive: true })
      writeFileSync(join(c.far, 'a', 'b', 'id'), 'agent')
      mkdirSync(join(c.outside, 'a', 'b'), { recursive: true })
      writeFileSync(join(c.outside, 'a', 'b', 'id'), 'secret')
      swap = swapForLink(join(c.far, 'a'), join(c.outside, 'a'))
      expect(await c.ops.importInto([join(c.far, 'a', 'b', 'id')], c.drop, false)).toMatchObject({
        ok: false,
        error: 'failed',
      })
      expect(readdirSync(c.drop)).toEqual([])
    },
  )

  it.runIf(anchored)('refuses every transfer when /proc cannot vouch for a folder', async () => {
    const c = swapCase({
      ...base,
      readlink: async (path) => {
        if (path.startsWith('/proc/') || path.startsWith('/dev/fd/'))
          throw Object.assign(new Error('no proc'), { code: 'ENOENT' })
        return base.readlink(path)
      },
    })
    writeFileSync(join(c.far, 'a.txt'), 'a')
    expect(await c.ops.importInto([join(c.far, 'a.txt')], c.drop, false)).toMatchObject({
      ok: false,
      error: 'failed',
    })
    expect(await c.ops.importInto([join(c.far, 'a.txt')], c.drop, true)).toMatchObject({
      ok: false,
      error: 'failed',
    })
    expect(readdirSync(c.drop)).toEqual([])
    expect(existsSync(join(c.far, 'a.txt'))).toBe(true)
  })

  it.runIf(anchored)(
    'lists many varied names and stats entries it cannot open, as the system lstat does',
    async () => {
      const dir = tmp()
      const names = [
        '.hidden',
        '..dots',
        'ünï-çødé.txt',
        'e\u0301.txt',
        '日本語の名前.md',
        'x'.repeat(250),
        'with space',
        ...Array.from({ length: 300 }, (_, i) => `file-${i}-${'n'.repeat(i % 40)}`),
      ]
      for (const name of names) writeFileSync(join(dir, name), name)
      writeFileSync(join(dir, 'locked'), 'secret')
      chmodSync(join(dir, 'locked'), 0)
      const socket = join(dir, 's.sock')
      const server = createServer()
      await new Promise<void>((ok) => server.listen(socket, ok))
      const anchor = await openAnchor(base, dir, platform)
      try {
        expect((await anchor.list()).sort()).toEqual(readdirSync(dir).sort())
        expect((await anchor.list()).length).toBe(names.length + 2)
        const locked = await base.lstat(await anchor.at('locked'))
        expect(locked.isFile()).toBe(true)
        expect(locked.mode & 0o777).toBe(0)
        const sock = await base.lstat(await anchor.at('s.sock'))
        expect(sock.isFile() || sock.isDirectory() || sock.isSymbolicLink()).toBe(false)
        const real = lstatSync(join(dir, 'locked'))
        expect([locked.dev, locked.ino, locked.uid]).toEqual([real.dev, real.ino, real.uid])
      } finally {
        await anchor.close()
        await new Promise((ok) => server.close(ok))
        chmodSync(join(dir, 'locked'), 0o600)
      }
    },
  )

  it('a second drop of the same file while the first still fills numbers its copy and writes no name it did not claim', async () => {
    const held = heldFill('report (2).txt')
    const c = swapCase(held.fs)
    writeFileSync(join(c.drop, 'report.txt'), 'theirs')
    const source = join(c.far, 'report.txt')
    writeFileSync(source, 'dropped')
    const first = c.ops.importInto([source], c.drop, false)
    await held.holding
    expect(await c.ops.importInto([source], c.drop, false)).toEqual({
      ok: true,
      paths: [join(c.drop, 'report (3).txt')],
    })
    held.release()
    expect(await first).toEqual({ ok: true, paths: [join(c.drop, 'report (2).txt')] })
    expect(readFileSync(join(c.drop, 'report.txt'), 'utf8')).toBe('theirs')
    expect(readFileSync(join(c.drop, 'report (2).txt'), 'utf8')).toBe('dropped')
    expect(readFileSync(join(c.drop, 'report (3).txt'), 'utf8')).toBe('dropped')
    expect(readdirSync(c.drop).sort()).toEqual(['report (2).txt', 'report (3).txt', 'report.txt'])
  })

  it('never takes a name that appeared after it was picked', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'file'), 'new')
    mkdirSync(join(dir, 'folder'))
    symlinkSync(dir, join(dir, 'link'))
    writeFileSync(join(dir, 'taken'), 'theirs')
    const anchor = await openAnchor(base, dir, platform)
    try {
      for (const name of ['file', 'folder', 'link']) {
        const source = { anchor, name }
        const target = { anchor, name: 'taken' }
        expect(await moveExclusive(base, source, target, platform), name).toBe('taken')
        expect(await copyExclusive(base, source, target), name).toBe('taken')
        expect(existsSync(join(dir, name))).toBe(true)
      }
    } finally {
      await anchor.close()
    }
    expect(readFileSync(join(dir, 'taken'), 'utf8')).toBe('theirs')
  })

  it('never writes through a link already at a name it picked', async () => {
    const dir = tmp()
    const outside = tmp()
    writeFileSync(join(outside, 'victim'), 'outside')
    writeFileSync(join(dir, 'source.txt'), 'payload')
    symlinkSync(join(outside, 'victim'), join(dir, 'copy.txt'))
    const anchor = await openAnchor(base, dir, platform)
    try {
      expect(
        await copyExclusive(base, { anchor, name: 'source.txt' }, { anchor, name: 'copy.txt' }),
      ).toBe('taken')
    } finally {
      await anchor.close()
    }
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('outside')
  })

  it('refuses a destination that is no longer the folder it was checked as', async () => {
    const root = tmp()
    const outside = tmp()
    mkdirSync(join(root, 'dest'))
    const checked = lstatSync(join(root, 'dest'))
    renameSync(join(root, 'dest'), join(root, 'dest-real'))
    symlinkSync(outside, join(root, 'dest'))
    await expect(openAnchor(base, join(root, 'dest'), platform, checked)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })

  it('a Windows folder move through FileOps copies, then trashes the original', async () => {
    const root = tmp()
    const trashed: string[] = []
    const ops = new FileOps({
      roots: [root],
      platform: 'win32',
      trash: async (path) => {
        trashed.push(path)
        rmSync(path, { recursive: true, force: true })
      },
    })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'a')
    mkdirSync(join(root, 'docs'))
    expect(await ops.move([join(root, 'src')], join(root, 'docs'))).toEqual({
      ok: true,
      paths: [join(root, 'docs', 'src')],
    })
    expect(readFileSync(join(root, 'docs', 'src', 'a.ts'), 'utf8')).toBe('a')
    expect(trashed).toEqual([join(root, 'src')])
  })

  it('keeps main responsive while a large folder copies', async () => {
    const { root, outside, ops } = setup()
    const source = join(outside, 'big')
    mkdirSync(source)
    const chunk = Buffer.alloc(1024 * 1024, 7)
    for (let i = 0; i < 64; i++) writeFileSync(join(source, `part-${i}.bin`), chunk)
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 1)
    try {
      expect(await ops.importInto([source], root, false)).toMatchObject({ ok: true })
    } finally {
      clearInterval(timer)
    }
    expect(readdirSync(join(root, 'big'))).toHaveLength(64)
    expect(ticks).toBeGreaterThan(3)
  })
})

describe('freedesktop Trash on Linux', () => {
  const uid = process.getuid?.() ?? 0

  function trashCase(options: { homeTrash?: string; fs?: TransferFs; uid?: number } = {}) {
    const root = tmp()
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'notes.md'), 'mine')
    const homeTrash = options.homeTrash ?? join(tmp(), 'Trash')
    const ops = new FileOps({
      roots: [root],
      homeTrash,
      fs: options.fs,
      uid: options.uid,
      topdirOf: async (path) => path,
      trashAllowedAt: async () => false,
      trash: async () => {
        throw new Error('shell trash must not be used on Linux')
      },
    })
    return { root, homeTrash, ops, item: join(root, 'sub', 'notes.md') }
  }

  it.runIf(linux)('trashes through a data folder that is reached by a link', async () => {
    const base = tmp()
    mkdirSync(join(base, 'real-share'))
    symlinkSync(join(base, 'real-share'), join(base, 'share'))
    const c = trashCase({ homeTrash: join(base, 'share', 'Trash') })
    expect(await c.ops.trash([c.item])).toMatchObject({ ok: true })
    expect(readFileSync(join(base, 'real-share', 'Trash', 'files', 'notes.md'), 'utf8')).toBe(
      'mine',
    )
  })

  it.runIf(linux && existsSync('/dev/shm'))(
    'refuses a Trash on /dev/shm, a tmpfs below /dev, the way glib does, and says so',
    async () => {
      const shm = mkdtempSync(join('/dev/shm', 'ostia-fileops-'))
      dirs.push(shm)
      writeFileSync(join(shm, 'far.txt'), 'far')
      const root = tmp()
      const ops = new FileOps({
        roots: [root],
        homeTrash: join(tmp(), 'Trash'),
        trash: async () => {
          throw new Error('shell trash must not be used on Linux')
        },
      })
      expect(await ops.importInto([join(shm, 'far.txt')], root, true)).toEqual({
        ok: false,
        error: 'no-trash',
        paths: [join(root, 'far.txt')],
      })
      expect(readFileSync(join(shm, 'far.txt'), 'utf8')).toBe('far')
      expect(readdirSync(shm)).toEqual(['far.txt'])
    },
  )

  it.runIf(linux)(
    'keeps the full name in Path= and a short one in the Trash for a long name',
    async () => {
      const c = trashCase()
      const name = `${'n'.repeat(246)}.md`
      writeFileSync(join(c.root, 'sub', name), 'long')
      expect(await c.ops.trash([join(c.root, 'sub', name)])).toMatchObject({ ok: true })
      const [infoName] = readdirSync(join(c.homeTrash, 'info'))
      expect(Buffer.byteLength(infoName)).toBeLessThanOrEqual(255)
      const info = readFileSync(join(c.homeTrash, 'info', infoName), 'utf8')
      expect(info).toContain(`/sub/${name}\n`)
      const [trashed] = readdirSync(join(c.homeTrash, 'files'))
      expect(`${trashed}.trashinfo`).toBe(infoName)
      expect(readFileSync(join(c.homeTrash, 'files', trashed), 'utf8')).toBe('long')
    },
  )

  it.runIf(linux)(
    'leaves no trashinfo behind when writing it or claiming the entry fails',
    async () => {
      const failing = (what: 'write' | 'claim'): TransferFs => ({
        ...nodeTransferFs,
        open: (async (path: string, ...rest: unknown[]) => {
          const handle = await (nodeTransferFs.open as (...args: unknown[]) => Promise<FileHandle>)(
            path,
            ...rest,
          )
          if (what === 'write' && path.endsWith('.trashinfo')) {
            handle.writeFile = async () => {
              throw Object.assign(new Error('full'), { code: 'ENOSPC' })
            }
          }
          if (what === 'claim' && !path.endsWith('.trashinfo') && rest.length > 1) {
            await handle.close()
            throw Object.assign(new Error('io'), { code: 'EIO' })
          }
          return handle
        }) as TransferFs['open'],
      })
      for (const what of ['write', 'claim'] as const) {
        const c = trashCase({ fs: failing(what) })
        expect(await c.ops.trash([c.item]), what).toMatchObject({ ok: false, error: 'failed' })
        expect(readdirSync(join(c.homeTrash, 'info')), what).toEqual([])
        expect(readFileSync(c.item, 'utf8'), what).toBe('mine')
      }
    },
  )

  it.runIf(linux)('refuses a Trash whose files or info folder is not ours', async () => {
    const c = trashCase({ uid: uid + 1 })
    expect(await c.ops.trash([c.item])).toMatchObject({ ok: false, error: 'failed' })
    expect(readFileSync(c.item, 'utf8')).toBe('mine')
    expect(readdirSync(join(c.homeTrash, 'info'))).toEqual([])
  })

  it.runIf(linux && existsSync('/dev/shm'))(
    "uses a real user mount's own .Trash-$uid",
    async () => {
      const shm = mkdtempSync(join('/dev/shm', 'ostia-fileops-'))
      dirs.push(shm)
      writeFileSync(join(shm, 'far.txt'), 'far')
      const root = tmp()
      const ops = new FileOps({
        roots: [root],
        homeTrash: join(tmp(), 'Trash'),
        topdirOf: async () => shm,
        trashAllowedAt: async () => true,
        trash: async () => {
          throw new Error('shell trash must not be used on Linux')
        },
      })
      expect(await ops.importInto([join(shm, 'far.txt')], root, true)).toMatchObject({ ok: true })
      expect(readFileSync(join(shm, `.Trash-${uid}`, 'files', 'far.txt'), 'utf8')).toBe('far')
    },
  )
})

describe('FileOps.draggable', () => {
  it('hands out a real file or folder inside a root, never a root, a link or a path outside', async () => {
    const { root, outside, ops } = setup()
    writeFileSync(join(outside, 'secret'), 's')
    symlinkSync(join(outside, 'secret'), join(root, 'link'))
    expect(await ops.draggable(join(root, 'notes.md'))).toBe(join(root, 'notes.md'))
    expect(await ops.draggable(join(root, 'src'))).toBe(join(root, 'src'))
    expect(await ops.draggable(join(root, 'src', '..', 'notes.md'))).toBe(join(root, 'notes.md'))
    expect(await ops.draggable(root)).toBeNull()
    expect(await ops.draggable(join(root, 'link'))).toBeNull()
    expect(await ops.draggable(join(outside, 'secret'))).toBeNull()
    expect(await ops.draggable(join(root, 'missing'))).toBeNull()
    expect(await ops.draggable(42)).toBeNull()
  })
})
