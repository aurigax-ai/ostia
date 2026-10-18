import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sandboxCwd, spawnFolder } from './spawnCwd'

describe('spawnFolder', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'spawn-cwd-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('starts in the folder asked for when it exists', () => {
    expect(spawnFolder(home, '/nowhere')).toEqual({ cwd: home, missing: false })
  })

  it('starts in home without a note when no folder was asked for', () => {
    expect(spawnFolder(undefined, home)).toEqual({ cwd: home, missing: false })
  })

  it('expands a leading ~ against home', () => {
    expect(spawnFolder('~', home)).toEqual({ cwd: home, missing: false })
  })

  it('falls back to home and says so when the folder asked for is gone', () => {
    expect(spawnFolder(join(home, 'removed-worktree'), home)).toEqual({ cwd: home, missing: true })
  })
})

describe('sandboxCwd', () => {
  let root: string
  let w: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-cwd-')))
    w = join(root, 'w')
    mkdirSync(join(w, 'tree'), { recursive: true })
    mkdirSync(join(root, 'wide'))
    mkdirSync(join(root, 'wx'))
    symlinkSync('/etc', join(w, 'etc-link'))
    symlinkSync('/', join(w, 'root-link'))
    symlinkSync(join(w, 'tree'), join(w, 'tree-link'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps a folder inside the workspace and clamps one outside to the workspace folder', () => {
    expect(sandboxCwd(join(w, 'tree'), w)).toBe(join(w, 'tree'))
    expect(sandboxCwd(w, w)).toBe(w)
    expect(sandboxCwd(join(root, 'wide'), w)).toBe(w)
    expect(sandboxCwd(join(root, 'wx'), w)).toBe(w)
  })

  it('clamps a folder that leaves the workspace through .. to the workspace folder', () => {
    expect(sandboxCwd(`${w}/../wide`, w)).toBe(w)
    expect(sandboxCwd(`${w}/tree/../../wide`, w)).toBe(w)
  })

  it('starts in the resolved folder, which the kernel would reach', () => {
    expect(sandboxCwd(`${w}/tree/..`, w)).toBe(w)
    expect(sandboxCwd(join(w, 'tree-link'), w)).toBe(join(w, 'tree'))
  })

  it('clamps a symbolic link that points out of the workspace', () => {
    expect(sandboxCwd(join(w, 'etc-link'), w)).toBe(w)
    expect(sandboxCwd(join(w, 'root-link'), w)).toBe(w)
    expect(sandboxCwd(`${w}/etc-link/..`, w)).toBe(w)
  })

  it('clamps a folder that does not exist to the workspace folder', () => {
    expect(sandboxCwd(join(w, 'gone'), w)).toBe(w)
  })
})
