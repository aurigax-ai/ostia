import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadJson, saveJson, storePath } from './jsonStore'

function unsetEnv(key: string): void {
  delete process.env[key]
}

describe('jsonStore', () => {
  describe('storePath', () => {
    it('project scope resolves under <workDir>/.pine/<name>.json', () => {
      expect(storePath('notes', 'project', '/work/dir')).toBe(
        join('/work/dir', '.pine', 'notes.json'),
      )
    })

    it('project scope with no workDir falls back to process.cwd()', () => {
      expect(storePath('notes', 'project')).toBe(join(process.cwd(), '.pine', 'notes.json'))
    })

    it('project scope with a blank workDir falls back to process.cwd()', () => {
      expect(storePath('notes', 'project', '   ')).toBe(join(process.cwd(), '.pine', 'notes.json'))
    })

    it('global scope resolves under XDG_DATA_HOME when set', () => {
      const prev = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = '/xdg/data'
      try {
        expect(storePath('notes', 'global')).toBe(join('/xdg/data', 'pine', 'notes.json'))
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
          join(homedir(), '.local', 'share', 'pine', 'notes.json'),
        )
      } finally {
        if (prev !== undefined) process.env.XDG_DATA_HOME = prev
      }
    })
  })

  describe('saveJson / loadJson', () => {
    let dir: string

    beforeEach(() => {
      dir = join(tmpdir(), `pine-jsonstore-test-${process.pid}-${Date.now()}-${Math.random()}`)
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

    it('leaves no .tmp file behind after an atomic write', () => {
      const path = join(dir, 'store.json')
      saveJson(path, { a: 1 })
      expect(existsSync(path)).toBe(true)
      expect(existsSync(`${path}.tmp`)).toBe(false)
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
  })
})
