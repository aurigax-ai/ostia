import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type FileChange, FileWatches } from './fileWatch'

const roots: string[] = []

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-fwatch-')))
  roots.push(root)
  const changes: FileChange[] = []
  const watches = new FileWatches({
    roots: [root],
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
