import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { leftBehindBaseline, leftBehindSince, watchLeftBehind } from './leftBehind'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-left-behind-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function repo(at: string): void {
  mkdirSync(join(at, '.git/hooks'), { recursive: true })
  writeFileSync(join(at, '.git/config'), '[core]\n')
}

describe('leftBehindSince', () => {
  it('lists a changed git config and a new hook of an existing repository', async () => {
    repo(dir)
    const baseline = await leftBehindBaseline(dir)
    writeFileSync(join(dir, '.git/config'), '[core]\n\tfsmonitor = x\n')
    writeFileSync(join(dir, '.git/hooks/pre-commit'), 'x')
    expect(await leftBehindSince(dir, baseline)).toEqual(['.git/config', '.git/hooks/pre-commit'])
  })

  it('lists a changed .envrc and a git file that appeared in a nested folder', async () => {
    writeFileSync(join(dir, '.envrc'), 'a')
    mkdirSync(join(dir, 'a/b'), { recursive: true })
    const baseline = await leftBehindBaseline(dir)
    writeFileSync(join(dir, '.envrc'), 'bb')
    writeFileSync(join(dir, 'a/b/.git'), 'gitdir: ../../x')
    expect(await leftBehindSince(dir, baseline)).toEqual(['.envrc', 'a/b/.git'])
  })

  it('names a new repository once, without its config and hooks', async () => {
    const baseline = await leftBehindBaseline(dir)
    repo(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub/.git/hooks/post-merge'), 'x')
    expect(await leftBehindSince(dir, baseline)).toEqual(['sub/.git'])
  })

  it('lists nothing when only unchanged files and ordinary files exist', async () => {
    repo(dir)
    writeFileSync(join(dir, '.envrc'), 'a')
    const baseline = await leftBehindBaseline(dir)
    writeFileSync(join(dir, 'file.txt'), 'x')
    utimesSync(join(dir, 'file.txt'), 1, 1)
    expect(await leftBehindSince(dir, baseline)).toEqual([])
  })

  it('does not follow a link out of the folder or enter node_modules', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ostia-left-outside-'))
    try {
      const baseline = await leftBehindBaseline(dir)
      repo(outside)
      symlinkSync(outside, join(dir, 'link'))
      repo(join(dir, 'node_modules/pkg'))
      expect(await leftBehindSince(dir, baseline)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('stops looking below the depth cap', async () => {
    const baseline = await leftBehindBaseline(dir)
    repo(join(dir, 'a/b/c/d/e/f/g/h'))
    expect(await leftBehindSince(dir, baseline)).toEqual([])
  })
})

describe('watchLeftBehind', () => {
  it('reports once when the watch ends and says nothing for a quiet session', async () => {
    const seen: string[][] = []
    const quiet = watchLeftBehind(dir, (paths) => seen.push(paths))
    quiet()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual([])
    const busy = watchLeftBehind(dir, (paths) => seen.push(paths))
    await new Promise((resolve) => setTimeout(resolve, 50))
    writeFileSync(join(dir, '.envrc'), 'x')
    busy()
    busy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen).toEqual([['.envrc']])
  })
})
