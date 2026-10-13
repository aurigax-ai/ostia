import { mkdtempSync, rmSync } from 'node:fs'
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
  it('keeps a folder inside the workspace and clamps one outside to the workspace folder', () => {
    expect(sandboxCwd('/w/tree', '/w')).toBe('/w/tree')
    expect(sandboxCwd('/home/u', '/w')).toBe('/w')
    expect(sandboxCwd('/wide', '/w')).toBe('/w')
  })
})
