import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadJson, saveJson, saveJsonAsync, storePath } from './jsonStore'

const written = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const { dirname } = await import('node:path')
  const modes = (file: string) =>
    [file, dirname(file)].map((p) => (fs.statSync(p).mode & 0o777).toString(8)).join(' ')
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      written.push(`open ${modes(String(args[0]))}`)
      return fd
    },
    fsyncSync: (fd: number) => {
      written.push('fsync')
      fs.fsyncSync(fd)
    },
    renameSync: (from: string, to: string) => {
      written.push(`rename ${modes(from)}`)
      fs.renameSync(from, to)
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const { dirname } = await import('node:path')
  const modes = async (file: string) => {
    const stats = await Promise.all([fs.stat(file), fs.stat(dirname(file))])
    return stats.map((st) => (st.mode & 0o777).toString(8)).join(' ')
  }
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      written.push(`open ${await modes(String(args[0]))}`)
      const sync = handle.sync.bind(handle)
      handle.sync = () => {
        written.push('fsync')
        return sync()
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      written.push(`rename ${await modes(from)}`)
      await fs.rename(from, to)
    },
  }
})

const SECURE_WRITE = ['open 600 700', 'fsync', 'rename 600 700']

function unsetEnv(key: string): void {
  delete process.env[key]
}

describe('jsonStore', () => {
  describe('storePath', () => {
    it('project scope resolves under <workDir>/.ostia/<name>.json', () => {
      expect(storePath('notes', 'project', '/work/dir')).toBe(
        join('/work/dir', '.ostia', 'notes.json'),
      )
    })

    it('project scope with no workDir falls back to process.cwd()', () => {
      expect(storePath('notes', 'project')).toBe(join(process.cwd(), '.ostia', 'notes.json'))
    })

    it('project scope with a blank workDir falls back to process.cwd()', () => {
      expect(storePath('notes', 'project', '   ')).toBe(join(process.cwd(), '.ostia', 'notes.json'))
    })

    it('global scope resolves under XDG_DATA_HOME when set', () => {
      const prev = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = '/xdg/data'
      try {
        expect(storePath('notes', 'global')).toBe(join('/xdg/data', 'ostia', 'notes.json'))
      } finally {
        if (prev === undefined) unsetEnv('XDG_DATA_HOME')
        else process.env.XDG_DATA_HOME = prev
      }
    })

    it('global scope falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
      const prev = process.env.XDG_DATA_HOME
      unsetEnv('XDG_DATA_HOME')
      try {
        expect(storePath('notes', 'global')).toBe(
          join(homedir(), '.local', 'share', 'ostia', 'notes.json'),
        )
      } finally {
        if (prev !== undefined) process.env.XDG_DATA_HOME = prev
      }
    })
  })

  describe('saveJson / loadJson', () => {
    let dir: string

    beforeEach(() => {
      dir = join(tmpdir(), `ostia-jsonstore-test-${process.pid}-${Date.now()}-${Math.random()}`)
      written.length = 0
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('round-trips data through saveJson then loadJson', () => {
      const path = join(dir, 'sub', 'store.json')
      const data = { hello: 'world', n: 42 }
      saveJson(path, data)
      expect(loadJson(path, null)).toEqual(data)
    })

    it('creates parent directories as needed', () => {
      const path = join(dir, 'deep', 'nested', 'dir', 'store.json')
      saveJson(path, { a: 1 })
      expect(existsSync(path)).toBe(true)
    })

    it('leaves no temp file behind after an atomic write', () => {
      const path = join(dir, 'store.json')
      saveJson(path, { a: 1 })
      expect(readdirSync(dir)).toEqual(['store.json'])
    })

    it('removes the temp file when the rename fails', () => {
      const path = join(dir, 'store.json')
      mkdirSync(join(path, 'occupied'), { recursive: true })
      expect(() => saveJson(path, { a: 1 })).toThrow()
      expect(readdirSync(dir)).toEqual(['store.json'])
    })

    it('never has a secure store or its new folder wider than 0600/0700 while it is written', () => {
      saveJson(join(dir, 'secure', 'store.json'), { a: 1 }, { secure: true })
      expect(written).toEqual(SECURE_WRITE)
    })

    it('tightens an existing secure folder before the store is written', async () => {
      const folder = join(dir, 'secure')
      mkdirSync(folder, { recursive: true })
      chmodSync(folder, 0o755)
      saveJson(join(folder, 'sync.json'), { a: 1 }, { secure: true })
      chmodSync(folder, 0o755)
      await saveJsonAsync(join(folder, 'async.json'), { a: 1 }, { secure: true })
      expect(written).toEqual([...SECURE_WRITE, ...SECURE_WRITE])
    })

    it('never has an async secure store or its new folder wider than 0600/0700 while it is written', async () => {
      await saveJsonAsync(join(dir, 'secure', 'store.json'), { a: 1 }, { secure: true })
      expect(written).toEqual(SECURE_WRITE)
    })

    it('leaves valid JSON from one of two concurrent writes to the same store', async () => {
      const path = join(dir, 'store.json')
      const first = { fill: 'a'.repeat(1 << 20) }
      const second = { fill: 'b'.repeat(1 << 20) }
      await Promise.all([
        saveJsonAsync(path, first, { secure: true }),
        saveJsonAsync(path, second, { secure: true }),
      ])
      expect([first, second]).toContainEqual(JSON.parse(readFileSync(path, 'utf8')))
      expect(readdirSync(dir)).toEqual(['store.json'])
    })

    it('loadJson returns the fallback for a missing path', () => {
      const path = join(dir, 'does-not-exist.json')
      expect(loadJson(path, { fallback: true })).toEqual({ fallback: true })
    })

    it('loadJson returns the fallback for corrupt JSON', () => {
      const path = join(dir, 'corrupt.json')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, '{ not valid json', 'utf8')
      expect(loadJson(path, { fallback: true })).toEqual({ fallback: true })
    })

    it('keeps a secure store and its folder readable only by the owner', () => {
      const path = join(dir, 'secure', 'store.json')
      saveJson(path, { a: 1 }, { secure: true })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'secure')).mode & 0o777).toBe(0o700)
    })

    it('replaces a symlink at the store path and leaves the file it pointed at alone', () => {
      mkdirSync(dir, { recursive: true })
      const target = join(dir, 'target.txt')
      const path = join(dir, 'store.json')
      writeFileSync(target, 'untouched', 'utf8')
      symlinkSync(target, path)
      saveJson(path, { a: 1 })
      expect(lstatSync(path).isSymbolicLink()).toBe(false)
      expect(loadJson(path, null)).toEqual({ a: 1 })
      expect(readFileSync(target, 'utf8')).toBe('untouched')
    })
  })
})
