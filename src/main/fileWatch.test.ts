import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type FileChange, FileWatches, type TreeChange, TreeWatches } from './fileWatch'
import { resolveSafe } from './pathGuard'

const roots: string[] = []
const opened: { closeAll: () => void }[] = []
const onLinux = process.platform === 'linux'

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

function setup(debounceMs = 30) {
  const root = tempDir('pine-fwatch-')
  const changes: FileChange[] = []
  const watches = new FileWatches({
    confine: (path) => resolveSafe(path, [root]),
    debounceMs,
    onChange: (change) => changes.push(change),
  })
  opened.push(watches)
  return { root, changes, watches }
}

async function until<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function kernelWatchesOn(dirs: string[]): number {
  const inodes = new Set(dirs.map((dir) => statSync(dir).ino.toString(16)))
  let count = 0
  for (const fd of readdirSync('/proc/self/fdinfo')) {
    let info = ''
    try {
      info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    } catch {
      continue
    }
    for (const line of info.split('\n')) {
      const inode = /^inotify wd:\S+ ino:([0-9a-f]+)/.exec(line)?.[1]
      if (inode && inodes.has(inode)) count++
    }
  }
  return count
}

afterEach(() => {
  for (const watches of opened.splice(0)) watches.closeAll()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('FileWatches', () => {
  it('ERL-C1 notices a write-then-rename save within a second', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'one')
    expect(watches.watch('win-1', file)).toBe(true)
    const started = Date.now()
    writeFileSync(join(root, '.a.txt.tmp'), 'two')
    renameSync(join(root, '.a.txt.tmp'), file)
    const change = await until(() => changes.find((c) => c.path === file))
    expect(change).toMatchObject({ path: file, exists: true, owners: ['win-1'] })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('ERL-C2 refuses to watch a file outside the folders Pine may read', () => {
    const { watches } = setup()
    expect(watches.watch('win-1', '/etc/hostname')).toBe(false)
    expect(watches.watchedDirs()).toEqual([])
  })

  it('ERL-C3 keeps a folder watched while any window has a file open in it', () => {
    const { root, watches } = setup()
    mkdirSync(join(root, 'sub'))
    const file = join(root, 'sub', 'b.txt')
    writeFileSync(file, 'x')
    watches.watch('win-1', file)
    watches.watch('win-2', file)
    watches.unwatch('win-1', file)
    expect(watches.watchedDirs()).toEqual([join(root, 'sub')])
    watches.unwatch('win-2', file)
    expect(watches.watchedDirs()).toEqual([])
  })

  it('stays silent when a watched file is rewritten with the same content', async () => {
    const { root, changes, watches } = setup()
    const same = join(root, 'same.txt')
    const other = join(root, 'other.txt')
    writeFileSync(same, 'one')
    writeFileSync(other, 'one')
    watches.watch('win-1', same)
    watches.watch('win-1', other)
    writeFileSync(same, 'one')
    writeFileSync(join(root, '.same.txt.tmp'), 'one')
    renameSync(join(root, '.same.txt.tmp'), same)
    await pause(120)
    writeFileSync(other, 'two')
    await until(() => changes.find((c) => c.path === other))
    await pause(120)
    expect(changes.map((c) => c.path)).toEqual([other])
  })

  it('reports once for a burst of writes, with the last content on disk', async () => {
    const { root, changes, watches } = setup(80)
    const file = join(root, 'a.txt')
    writeFileSync(file, 'zero')
    watches.watch('win-1', file)
    for (const text of ['one', 'two', 'three']) {
      writeFileSync(file, text)
      await pause(20)
    }
    await until(() => changes.find((c) => c.path === file))
    await pause(200)
    expect(changes).toEqual([{ path: file, exists: true, owners: ['win-1'] }])
    expect(readFileSync(file, 'utf8')).toBe('three')
  })

  it('reports a second write that lands soon after the first was reported', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'zero')
    watches.watch('win-1', file)
    writeFileSync(file, 'one')
    await until(() => changes.find((c) => c.path === file))
    writeFileSync(file, 'two')
    await until(() => (changes.length === 2 ? changes : undefined))
  })

  it('reports a watched file deleted and then its return', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'one')
    watches.watch('win-1', file)
    watches.watch('win-2', file)
    unlinkSync(file)
    await until(() => changes.find((c) => !c.exists))
    writeFileSync(file, 'back')
    await until(() => (changes.length === 2 ? changes : undefined))
    expect(changes).toEqual([
      { path: file, exists: false, owners: ['win-1', 'win-2'] },
      { path: file, exists: true, owners: ['win-1', 'win-2'] },
    ])
  })

  it('reports a file that changes from a link into a regular file', async () => {
    const { root, changes, watches } = setup()
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    writeFileSync(target, 'one')
    symlinkSync(target, link)
    watches.watch('win-1', link)
    writeFileSync(join(root, '.link.txt.tmp'), 'two')
    renameSync(join(root, '.link.txt.tmp'), link)
    const change = await until(() => changes.find((c) => c.path === link))
    expect(change.exists).toBe(true)
  })

  it('watches a file opened through a linked folder, under the path it was opened with', async () => {
    const { root, changes, watches } = setup()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'linked'))
    const file = join(root, 'linked', 'a.txt')
    writeFileSync(file, 'one')
    expect(watches.watch('win-1', file)).toBe(true)
    writeFileSync(join(root, 'real', 'a.txt'), 'two')
    const change = await until(() => changes[0])
    expect(change).toEqual({ path: file, exists: true, owners: ['win-1'] })
  })

  it('refuses a file whose folder does not exist', () => {
    const { root, watches } = setup()
    expect(watches.watch('win-1', join(root, 'missing', 'a.txt'))).toBe(false)
    expect(watches.watchedDirs()).toEqual([])
  })

  it('reports nothing about files it was not asked to watch', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'one')
    watches.watch('win-1', file)
    writeFileSync(join(root, 'unwatched.txt'), 'x')
    writeFileSync(file, 'two')
    await until(() => changes.find((c) => c.path === file))
    await pause(100)
    expect(changes.map((c) => c.path)).toEqual([file])
  })

  it.skipIf(!onLinux)(
    'holds one kernel watch per folder, never polls, and releases it (Linux only: inotify watch counts)',
    async () => {
      const { root, changes, watches } = setup()
      const base = tempDir('pine-fwatch-base-')
      const file = join(root, 'a.txt')
      writeFileSync(file, 'one')
      writeFileSync(join(root, 'b.txt'), 'one')
      watches.watch('win-1', file)
      watches.watch('win-1', join(root, 'b.txt'))
      expect(kernelWatchesOn([root])).toBe(1)
      expect(kernelWatchesOn([file, base, tmpdir()])).toBe(0)
      writeFileSync(file, 'two')
      await until(() => changes.find((c) => c.path === file))
      watches.closeAll()
      expect(watches.watchedDirs()).toEqual([])
      expect(kernelWatchesOn([root])).toBe(0)
    },
  )

  it('reports a watched file as gone when its folder vanishes, and nothing from the folder above', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'sub', 'a.txt')
    mkdirSync(join(root, 'sub'))
    writeFileSync(file, 'one')
    expect(watches.watch('win-1', file)).toBe(true)
    rmSync(join(root, 'sub'), { recursive: true })
    await until(() => changes.find((c) => c.path === file))
    await pause(150)
    expect(changes).toEqual([{ path: file, exists: false, owners: ['win-1'] }])
  })

  it('stops reporting once a window lets go of its files', async () => {
    const { root, changes, watches } = setup()
    const file = join(root, 'a.txt')
    writeFileSync(file, 'one')
    watches.watch('win-1', file)
    watches.unwatchOwner('win-1')
    expect(watches.watchedDirs()).toEqual([])
    writeFileSync(file, 'two')
    await pause(150)
    expect(changes).toEqual([])
  })
})

function tree(maxDirs?: number) {
  const base = tempDir('pine-twatch-')
  const root = join(base, 'root')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'))
  mkdirSync(join(base, 'sibling'))
  writeFileSync(join(root, 'src', 'a.txt'), 'one')
  const changes: TreeChange[] = []
  const batches: TreeChange[][] = []
  const watches = new TreeWatches({
    confine: (dir) => resolveSafe(dir, [base]),
    debounceMs: 30,
    ...(maxDirs !== undefined ? { maxDirs } : {}),
  })
  opened.push(watches)
  const listen = (batch: TreeChange[]): void => {
    batches.push(batch)
    changes.push(...batch)
  }
  const seen = (path: string, kind: TreeChange['kind']): TreeChange | undefined =>
    changes.find((c) => c.path === path && c.kind === kind)
  return { base, root, changes, batches, watches, listen, seen }
}

describe('TreeWatches', () => {
  it('reports a file created, changed and deleted anywhere under the root', async () => {
    const { root, watches, listen, seen } = tree()
    const stop = watches.watch(root, listen)
    expect(stop).not.toBeNull()
    const created = join(root, 'src', 'deep', 'new.txt')
    writeFileSync(created, 'x')
    await until(() => seen(created, 'created'))
    writeFileSync(join(root, 'src', 'a.txt'), 'two')
    await until(() => seen(join(root, 'src', 'a.txt'), 'changed'))
    unlinkSync(created)
    await until(() => seen(created, 'deleted'))
  })

  it('reports the files of a root that vanished as deleted and nothing from beside it', async () => {
    const { base, root, changes, watches, listen, seen } = tree()
    watches.watch(root, listen)
    rmSync(root, { recursive: true })
    await until(() => seen(join(root, 'src', 'a.txt'), 'deleted'))
    writeFileSync(join(base, 'sibling', 'x.txt'), 'x')
    await pause(150)
    expect(changes.every((c) => c.kind === 'deleted' && c.path.startsWith(`${root}/`))).toBe(true)
    expect(watches.watchedDirs(root)).not.toContain(join(root, 'src'))
  })

  it('watches a folder made later and reports the files already in it', async () => {
    const { root, watches, listen, seen } = tree()
    watches.watch(root, listen)
    const made = join(root, 'src', 'later')
    mkdirSync(made)
    writeFileSync(join(made, 'first.txt'), 'x')
    await until(() => seen(join(made, 'first.txt'), 'created'))
    writeFileSync(join(made, 'second.txt'), 'y')
    await until(() => seen(join(made, 'second.txt'), 'created'))
    expect(watches.watchedDirs(root)).toContain(made)
  })

  it('loses no file written into folders as they are being made', async () => {
    const { root, changes, watches, listen } = tree()
    watches.watch(root, listen)
    const made: string[] = []
    for (let folder = 0; folder < 12; folder++) {
      const dir = join(root, 'src', `bulk-${folder}`, 'inner')
      mkdirSync(dir, { recursive: true })
      for (let file = 0; file < 20; file++) {
        made.push(join(dir, `f${file}.txt`))
        writeFileSync(join(dir, `f${file}.txt`), 'x')
        if (file % 5 === 4) await pause(0)
      }
    }
    const created = (): Set<string> =>
      new Set(changes.filter((c) => c.kind === 'created').map((c) => c.path))
    await until(() => (made.every((path) => created().has(path)) ? true : undefined), 10_000)
  })

  it('delivers changes made together as one batch of path and kind', async () => {
    const { root, batches, watches, listen } = tree()
    watches.watch(root, listen)
    writeFileSync(join(root, 'one.txt'), 'x')
    writeFileSync(join(root, 'src', 'two.txt'), 'x')
    writeFileSync(join(root, 'src', 'a.txt'), 'two')
    const first = await until(() => batches[0])
    expect([...first].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: join(root, 'one.txt'), kind: 'created' },
      { path: join(root, 'src', 'a.txt'), kind: 'changed' },
      { path: join(root, 'src', 'two.txt'), kind: 'created' },
    ])
    await pause(100)
    expect(batches).toHaveLength(1)
  })

  it('reports a second write to a file that lands right after a batch went out', async () => {
    const { root, changes, watches, listen } = tree()
    const file = join(root, 'src', 'a.txt')
    watches.watch(root, listen)
    writeFileSync(file, 'two')
    await until(() => changes[0])
    writeFileSync(file, 'three')
    await until(() => (changes.length === 2 ? changes : undefined))
    expect(changes).toEqual([
      { path: file, kind: 'changed' },
      { path: file, kind: 'changed' },
    ])
  })

  it('never descends into dependency or version-control folders, or through a linked folder', async () => {
    const { root, changes, watches, listen } = tree()
    const outside = tempDir('pine-twatch-out-')
    symlinkSync(outside, join(root, 'linked'))
    watches.watch(root, listen)
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'src'), join(root, 'src', 'deep')])
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(outside, 'secret.txt'), 'x')
    writeFileSync(join(root, 'src', 'marker.txt'), 'x')
    await until(() => changes.find((c) => c.path === join(root, 'src', 'marker.txt')))
    expect(changes.map((c) => c.path)).toEqual([join(root, 'src', 'marker.txt')])
  })

  it('reports a link to a folder made later as one created path and never looks inside it', async () => {
    const { root, changes, watches, listen, seen } = tree()
    const outside = tempDir('pine-twatch-out-')
    writeFileSync(join(outside, 'before.txt'), 'x')
    watches.watch(root, listen)
    const link = join(root, 'src', 'linked')
    symlinkSync(outside, link)
    await until(() => seen(link, 'created'))
    writeFileSync(join(outside, 'secret.txt'), 'x')
    mkdirSync(join(root, 'src', 'node_modules'))
    writeFileSync(join(root, 'src', 'node_modules', 'index.js'), 'x')
    writeFileSync(join(root, 'src', 'marker.txt'), 'x')
    await until(() => seen(join(root, 'src', 'marker.txt'), 'created'))
    await pause(100)
    expect(changes.map((c) => c.path).sort()).toEqual([link, join(root, 'src', 'marker.txt')])
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'src'), join(root, 'src', 'deep')])
  })

  it.skipIf(!onLinux)(
    'holds one kernel watch per watched folder and none on skipped, linked or outside folders (Linux only: inotify watch counts)',
    async () => {
      const { base, root, watches, listen } = tree()
      const outside = tempDir('pine-twatch-out-')
      symlinkSync(outside, join(root, 'linked'))
      watches.watch(root, listen)
      const watched = [root, join(root, 'src'), join(root, 'src', 'deep')]
      expect(kernelWatchesOn(watched)).toBe(3)
      expect(
        kernelWatchesOn([
          base,
          join(base, 'sibling'),
          outside,
          tmpdir(),
          join(root, '.git'),
          join(root, 'node_modules'),
          join(root, 'node_modules', 'pkg'),
          join(root, 'src', 'a.txt'),
        ]),
      ).toBe(0)
      writeFileSync(join(base, 'sibling', 'x.txt'), 'x')
      writeFileSync(join(base, 'beside.txt'), 'x')
      await pause(120)
      watches.closeAll()
      expect(kernelWatchesOn(watched)).toBe(0)
    },
  )

  it('reports nothing from beside or above the root', async () => {
    const { base, root, changes, watches, listen } = tree()
    watches.watch(root, listen)
    writeFileSync(join(base, 'sibling', 'x.txt'), 'x')
    writeFileSync(join(base, 'beside.txt'), 'x')
    writeFileSync(join(root, 'marker.txt'), 'x')
    await until(() => changes.find((c) => c.path === join(root, 'marker.txt')))
    await pause(100)
    expect(changes.map((c) => c.path)).toEqual([join(root, 'marker.txt')])
  })

  it('refuses a folder outside the readable roots and stops at the folder limit', () => {
    const { root, watches } = tree(2)
    expect(watches.watch('/etc', () => {})).toBeNull()
    expect(watches.watch(join(root, 'src', 'a.txt'), () => {})).toBeNull()
    watches.watch(root, () => {})
    expect(watches.watchedDirs(root)).toHaveLength(2)
  })

  it('refuses a root that is a link to a folder', () => {
    const { base, root, watches } = tree()
    symlinkSync(root, join(base, 'alias'))
    expect(watches.watch(join(base, 'alias'), () => {})).toBeNull()
  })

  it('at the folder limit watches the nearest folders first and leaves the rest unwatched', async () => {
    const { root, changes, watches, listen, seen } = tree(3)
    mkdirSync(join(root, 'lib'))
    watches.watch(root, listen)
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'lib'), join(root, 'src')])
    if (onLinux) {
      expect(kernelWatchesOn([root, join(root, 'lib'), join(root, 'src')])).toBe(3)
      expect(kernelWatchesOn([join(root, 'src', 'deep')])).toBe(0)
    }
    writeFileSync(join(root, 'src', 'deep', 'unseen.txt'), 'x')
    mkdirSync(join(root, 'lib', 'later'))
    writeFileSync(join(root, 'lib', 'later', 'unseen.txt'), 'x')
    writeFileSync(join(root, 'lib', 'marker.txt'), 'x')
    await until(() => seen(join(root, 'lib', 'marker.txt'), 'created'))
    await pause(100)
    expect(changes.map((c) => c.path)).toEqual([join(root, 'lib', 'marker.txt')])
    expect(watches.watchedDirs(root)).toHaveLength(3)
  })

  it('watches a new folder once a removed one made room under the limit', async () => {
    const { root, watches, listen, seen } = tree(3)
    watches.watch(root, listen)
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'src'), join(root, 'src', 'deep')])
    rmSync(join(root, 'src', 'deep'), { recursive: true })
    await until(() => (watches.watchedDirs(root).length === 2 ? true : undefined))
    mkdirSync(join(root, 'src', 'next'))
    writeFileSync(join(root, 'src', 'next', 'in.txt'), 'x')
    await until(() => seen(join(root, 'src', 'next', 'in.txt'), 'created'))
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'src'), join(root, 'src', 'next')])
  })

  it('reports the files of a removed folder as deleted and stops watching it', async () => {
    const { root, watches, listen, seen } = tree()
    writeFileSync(join(root, 'src', 'deep', 'in.txt'), 'x')
    watches.watch(root, listen)
    rmSync(join(root, 'src'), { recursive: true })
    await until(() => seen(join(root, 'src', 'deep', 'in.txt'), 'deleted'))
    await until(() => seen(join(root, 'src', 'a.txt'), 'deleted'))
    await until(() => (watches.watchedDirs(root).length === 1 ? true : undefined))
  })

  it('closes its watchers when the last listener leaves', async () => {
    const { root, changes, watches, listen } = tree()
    const first = watches.watch(root, listen)
    const second = watches.watch(root, () => {})
    first?.()
    expect(watches.watchedDirs(root).length).toBeGreaterThan(0)
    second?.()
    expect(watches.watchedDirs(root)).toEqual([])
    watches.closeAll()
    if (onLinux)
      expect(kernelWatchesOn([root, join(root, 'src'), join(root, 'src', 'deep')])).toBe(0)
    writeFileSync(join(root, 'src', 'after.txt'), 'x')
    await pause(120)
    expect(changes).toEqual([])
  })
})
