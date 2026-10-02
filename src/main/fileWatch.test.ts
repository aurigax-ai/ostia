import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
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

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-fwatch-')))
  roots.push(root)
  const changes: FileChange[] = []
  const watches = new FileWatches({
    confine: (path) => resolveSafe(path, [root]),
    debounceMs: 30,
    onChange: (change) => changes.push(change),
  })
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

afterEach(() => {
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
    watches.closeAll()
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
})

function tree(maxDirs?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-twatch-')))
  roots.push(root)
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'src', 'a.txt'), 'one')
  const changes: TreeChange[] = []
  const watches = new TreeWatches({
    confine: (dir) => resolveSafe(dir, [root]),
    debounceMs: 30,
    ...(maxDirs !== undefined ? { maxDirs } : {}),
  })
  const seen = (path: string, kind: TreeChange['kind']): TreeChange | undefined =>
    changes.find((c) => c.path === path && c.kind === kind)
  return { root, changes, watches, seen }
}

describe('TreeWatches', () => {
  it('reports a file created, changed and deleted anywhere under the root', async () => {
    const { root, changes, watches, seen } = tree()
    const stop = watches.watch(root, (batch) => changes.push(...batch))
    expect(stop).not.toBeNull()
    const created = join(root, 'src', 'deep', 'new.txt')
    writeFileSync(created, 'x')
    await until(() => seen(created, 'created'))
    writeFileSync(join(root, 'src', 'a.txt'), 'two')
    await until(() => seen(join(root, 'src', 'a.txt'), 'changed'))
    unlinkSync(created)
    await until(() => seen(created, 'deleted'))
    watches.closeAll()
  })

  it('watches a folder made later and reports the files already in it', async () => {
    const { root, changes, watches, seen } = tree()
    watches.watch(root, (batch) => changes.push(...batch))
    const made = join(root, 'src', 'later')
    mkdirSync(made)
    writeFileSync(join(made, 'first.txt'), 'x')
    await until(() => seen(join(made, 'first.txt'), 'created'))
    writeFileSync(join(made, 'second.txt'), 'y')
    await until(() => seen(join(made, 'second.txt'), 'created'))
    watches.closeAll()
  })

  it('never descends into dependency or version-control folders, or through a linked folder', async () => {
    const { root, changes, watches } = tree()
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pine-twatch-out-')))
    roots.push(outside)
    symlinkSync(outside, join(root, 'linked'))
    watches.watch(root, (batch) => changes.push(...batch))
    expect(watches.watchedDirs(root)).toEqual([root, join(root, 'src'), join(root, 'src', 'deep')])
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    writeFileSync(join(outside, 'secret.txt'), 'x')
    writeFileSync(join(root, 'src', 'marker.txt'), 'x')
    await until(() => changes.find((c) => c.path === join(root, 'src', 'marker.txt')))
    expect(changes.map((c) => c.path)).toEqual([join(root, 'src', 'marker.txt')])
    watches.closeAll()
  })

  it('refuses a folder outside the readable roots and stops at the folder limit', () => {
    const { root, watches } = tree(2)
    expect(watches.watch('/etc', () => {})).toBeNull()
    expect(watches.watch(join(root, 'src', 'a.txt'), () => {})).toBeNull()
    watches.watch(root, () => {})
    expect(watches.watchedDirs(root)).toHaveLength(2)
    watches.closeAll()
  })

  it('closes its watchers when the last listener leaves', () => {
    const { root, watches } = tree()
    const first = watches.watch(root, () => {})
    const second = watches.watch(root, () => {})
    first?.()
    expect(watches.watchedDirs(root).length).toBeGreaterThan(0)
    second?.()
    expect(watches.watchedDirs(root)).toEqual([])
  })
})
