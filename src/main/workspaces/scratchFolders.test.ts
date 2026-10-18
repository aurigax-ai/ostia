import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCRATCH_HISTORY_FILE, ScratchFolders, countScratchFiles } from './scratchFolders'

const hooks = vi.hoisted(() => ({
  beforeRm: null as ((dir: string, attempt: number) => void) | null,
  calls: new Map<string, number>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      const dir = String(args[0])
      const attempt = (hooks.calls.get(dir) ?? 0) + 1
      hooks.calls.set(dir, attempt)
      hooks.beforeRm?.(dir, attempt)
      fs.rmSync(...args)
    },
  }
})

function enotempty(dir: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${dir}'`), {
    code: 'ENOTEMPTY',
  })
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-scratch-test-'))
})

afterEach(() => {
  hooks.beforeRm = null
  hooks.calls.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('ScratchFolders', () => {
  it('creates a fresh, empty, private folder per call under the root', () => {
    const folders = new ScratchFolders(root, 4242)
    const a = folders.create('1')
    const b = folders.create('1')
    expect(a).not.toBe(b)
    expect(dirname(a)).toBe(root)
    expect(basename(a)).toMatch(/^4242-[0-9a-f]{12}$/)
    expect(statSync(a).mode & 0o777).toBe(0o700)
    expect(countScratchFiles(a)).toBe(0)
  })

  it('binds a folder only to the workspace of the window that asked for it', () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    expect(folders.bind('w1', dir, '2')).toBe(false)
    expect(folders.bind('w1', '/home/u/project', '1')).toBe(false)
    expect(folders.bind('w1', dir, '1')).toBe(true)
    expect(folders.bind('w2', dir, '1')).toBe(false)
    expect(folders.dirOf('w1')).toBe(dir)
    expect(folders.isScratch('w1')).toBe(true)
    expect(folders.isScratch('w2')).toBe(false)
    expect(folders.historyFile('w1')).toBe(join(dir, SCRATCH_HISTORY_FILE))
    expect(folders.workspaceIds()).toEqual(['w1'])
  })

  it('counts files the human made, recursively, but not the shell history', () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    writeFileSync(join(dir, SCRATCH_HISTORY_FILE), 'echo hi\n')
    expect(folders.countFiles('w1')).toBe(0)
    writeFileSync(join(dir, 'a.txt'), 'hi')
    mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'deeper', 'b.txt'), 'hi')
    symlinkSync('/etc', join(dir, 'link'))
    expect(folders.countFiles('w1')).toBe(3)
  })

  it('deletes the folder when its workspace is removed and forgets it', () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    writeFileSync(join(dir, 'a.txt'), 'hi')
    folders.remove('w1')
    expect(existsSync(dir)).toBe(false)
    expect(folders.isScratch('w1')).toBe(false)
  })

  it('never follows a symlink inside the folder when deleting it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ostia-scratch-outside-'))
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    symlinkSync(outside, join(dir, 'outside'))
    folders.remove('w1')
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })

  it('removes every folder it made, bound or not, on quit', () => {
    const folders = new ScratchFolders(root, 4242)
    const bound = folders.create('1')
    const unbound = folders.create('1')
    folders.bind('w1', bound, '1')
    folders.removeAll()
    expect(existsSync(bound)).toBe(false)
    expect(existsSync(unbound)).toBe(false)
  })

  it('retries when the shell writes its history while the folder is being removed', () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    hooks.beforeRm = (target, attempt) => {
      if (attempt > 1) return
      writeFileSync(join(target, SCRATCH_HISTORY_FILE), 'exit\n')
      throw enotempty(target)
    }
    expect(folders.removeAll()).toEqual([])
    expect(hooks.calls.get(dir)).toBe(2)
    expect(existsSync(dir)).toBe(false)
  })

  it('reports a folder that resists removal and still removes the others', () => {
    const folders = new ScratchFolders(root, 4242)
    const stuck = folders.create('1')
    const other = folders.create('1')
    hooks.beforeRm = (target) => {
      if (target === stuck) throw enotempty(target)
    }
    expect(folders.removeAll()).toEqual([{ dir: stuck, code: 'ENOTEMPTY' }])
    expect(existsSync(other)).toBe(false)
    expect(folders.dirs()).toEqual([])
  })

  it('retries and contains a failed removal when a scratch workspace is closed', () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    hooks.beforeRm = (target, attempt) => {
      if (attempt > 1) return
      writeFileSync(join(target, SCRATCH_HISTORY_FILE), 'exit\n')
      throw enotempty(target)
    }
    expect(folders.remove('w1')).toBeNull()
    expect(existsSync(dir)).toBe(false)

    const stuck = folders.create('1')
    folders.bind('w2', stuck, '1')
    hooks.beforeRm = (target) => {
      throw enotempty(target)
    }
    expect(folders.remove('w2')).toEqual({ dir: stuck, code: 'ENOTEMPTY' })
    expect(folders.isScratch('w2')).toBe(false)
  })

  it('sweeps leftover folders of exited processes and keeps live ones', () => {
    const dead = join(root, '111-aaaaaaaaaaaa')
    const live = join(root, '222-bbbbbbbbbbbb')
    const unrelated = join(root, 'notes')
    for (const dir of [dead, live, unrelated]) mkdirSync(dir)
    writeFileSync(join(dead, 'a.txt'), 'hi')
    const folders = new ScratchFolders(root, 4242, (pid) => pid === 222)
    expect(folders.sweep()).toEqual([dead])
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })
})
