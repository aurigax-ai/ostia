import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countScratchFiles, SCRATCH_HISTORY_FILE, ScratchFolders } from './scratchFolders'

const hooks = vi.hoisted(() => ({
  beforeRm: null as ((dir: string, attempt: number) => void) | null,
  calls: new Map<string, number>(),
  stall: null as ((dir: string) => boolean) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      const dir = String(args[0])
      const attempt = (hooks.calls.get(dir) ?? 0) + 1
      hooks.calls.set(dir, attempt)
      hooks.beforeRm?.(dir, attempt)
      if (hooks.stall?.(dir)) return new Promise<void>(() => {})
      await fs.rm(...args)
    },
  }
})

function failing(dir: string, code = 'ENOTEMPTY'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: cannot remove '${dir}'`), { code })
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-scratch-test-'))
})

afterEach(() => {
  hooks.beforeRm = null
  hooks.stall = null
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

  it('deletes the folder when its workspace is removed and forgets it', async () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    writeFileSync(join(dir, 'a.txt'), 'hi')
    await folders.remove('w1')
    expect(existsSync(dir)).toBe(false)
    expect(folders.isScratch('w1')).toBe(false)
  })

  it('never follows a symlink inside the folder when deleting it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ostia-scratch-outside-'))
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    symlinkSync(outside, join(dir, 'outside'))
    await folders.remove('w1')
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })

  it('removes every folder it made, bound or not, on quit', async () => {
    const folders = new ScratchFolders(root, 4242)
    const bound = folders.create('1')
    const unbound = folders.create('1')
    folders.bind('w1', bound, '1')
    await folders.removeAll()
    expect(existsSync(bound)).toBe(false)
    expect(existsSync(unbound)).toBe(false)
  })

  it('retries when the shell writes its history while the folder is being removed', async () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    hooks.beforeRm = (target, attempt) => {
      if (attempt > 1) return
      writeFileSync(join(target, SCRATCH_HISTORY_FILE), 'exit\n')
      throw failing(target)
    }
    expect(await folders.removeAll()).toEqual([])
    expect(hooks.calls.get(dir)).toBe(2)
    expect(existsSync(dir)).toBe(false)
  })

  it('reports a folder that resists removal and still removes the others', async () => {
    const folders = new ScratchFolders(root, 4242)
    const stuck = folders.create('1')
    const other = folders.create('1')
    hooks.beforeRm = (target) => {
      if (target === stuck) throw failing(target)
    }
    expect(await folders.removeAll()).toEqual([{ dir: stuck, code: 'ENOTEMPTY' }])
    expect(existsSync(other)).toBe(false)
    expect(folders.dirs()).toEqual([])
  })

  it('retries and contains a failed removal when a scratch workspace is closed', async () => {
    const folders = new ScratchFolders(root, 4242)
    const dir = folders.create('1')
    folders.bind('w1', dir, '1')
    hooks.beforeRm = (target, attempt) => {
      if (attempt > 1) return
      writeFileSync(join(target, SCRATCH_HISTORY_FILE), 'exit\n')
      throw failing(target)
    }
    expect(await folders.remove('w1')).toBeNull()
    expect(existsSync(dir)).toBe(false)

    const stuck = folders.create('1')
    folders.bind('w2', stuck, '1')
    hooks.beforeRm = (target) => {
      throw failing(target)
    }
    expect(await folders.remove('w2')).toEqual({ dir: stuck, code: 'ENOTEMPTY' })
    expect(folders.isScratch('w2')).toBe(false)
  })

  it('returns before the retries finish when the folder is busy and still removes it', async () => {
    vi.useFakeTimers()
    try {
      const folders = new ScratchFolders(root, 4242)
      const dir = folders.create('1')
      folders.bind('w1', dir, '1')
      hooks.beforeRm = (target, attempt) => {
        if (attempt <= 2) throw failing(target, 'EBUSY')
      }
      let settled = false
      const removal = folders.remove('w1').then((failure) => {
        settled = true
        return failure
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(hooks.calls.get(dir)).toBe(1)
      expect(settled).toBe(false)
      expect(existsSync(dir)).toBe(true)
      await vi.advanceTimersByTimeAsync(25)
      expect(hooks.calls.get(dir)).toBe(2)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(50)
      expect(await removal).toBeNull()
      expect(hooks.calls.get(dir)).toBe(3)
      expect(existsSync(dir)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a removal already under way when everything is removed on quit', async () => {
    vi.useFakeTimers()
    try {
      const folders = new ScratchFolders(root, 4242)
      const dir = folders.create('1')
      folders.bind('w1', dir, '1')
      hooks.beforeRm = (target, attempt) => {
        if (attempt === 1) throw failing(target, 'EBUSY')
      }
      void folders.remove('w1')
      await vi.advanceTimersByTimeAsync(0)
      let done = false
      const all = folders.removeAll().then((failed) => {
        done = true
        return failed
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(false)
      expect(existsSync(dir)).toBe(true)
      await vi.advanceTimersByTimeAsync(25)
      expect(await all).toEqual([])
      expect(existsSync(dir)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweeps leftover folders of exited processes and keeps live ones', async () => {
    const dead = join(root, '111-aaaaaaaaaaaa')
    const live = join(root, '222-bbbbbbbbbbbb')
    const unrelated = join(root, 'notes')
    for (const dir of [dead, live, unrelated]) mkdirSync(dir)
    writeFileSync(join(dead, 'a.txt'), 'hi')
    const folders = new ScratchFolders(root, 4242, (pid) => pid === 222)
    expect(await folders.sweep()).toEqual({ removed: [dead], failed: [] })
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('keeps sweeping after a leftover folder resists and reports it by code only', async () => {
    const stuck = join(root, '111-aaaaaaaaaaaa')
    const other = join(root, '333-cccccccccccc')
    for (const dir of [stuck, other]) mkdirSync(dir)
    hooks.beforeRm = (target) => {
      if (target === stuck) throw failing(target, 'EACCES')
    }
    const folders = new ScratchFolders(root, 4242, () => false)
    expect(await folders.sweep()).toEqual({
      removed: [other],
      failed: [{ dir: stuck, code: 'EACCES' }],
    })
    expect(existsSync(other)).toBe(false)
    expect(existsSync(stuck)).toBe(true)
  })

  it('stops waiting for a removal that never settles once the quit deadline passes', async () => {
    const folders = new ScratchFolders(root, 4242)
    const hung = folders.create('1')
    const fine = folders.create('1')
    hooks.stall = (target) => target === hung
    expect(await folders.removeAll(50)).toEqual([{ dir: hung, code: 'TIMEOUT' }])
    expect(existsSync(fine)).toBe(false)
  })

  it('refuses to create a folder once everything is being removed on quit', async () => {
    const folders = new ScratchFolders(root, 4242)
    folders.create('1')
    const all = folders.removeAll()
    expect(() => folders.create('1')).toThrow('scratch folders are closed')
    await all
    expect(readdirSync(root)).toEqual([])
  })
})
