import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepOldGenerations } from './generatedFolder'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function generation(root: string, digit: string, age: number, files: string[]): string {
  const dir = join(root, digit.repeat(32))
  mkdirSync(dir, { recursive: true })
  for (const name of files) writeFileSync(join(dir, name), name)
  const when = Date.now() / 1000 - age * 86_400
  utimesSync(dir, when, when)
  return dir
}

describe('sweeping generation folders from earlier versions', () => {
  it('keeps the current and the newest few, and removes only folders of its own files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ostia-generations-'))
    roots.push(root)
    const owns = (name: string) => name === 'init.zsh' || name === '.zcompdump'
    const current = generation(root, 'a', 30, ['init.zsh'])
    const newest = ['b', 'c', 'd'].map((d, i) => generation(root, d, i + 1, ['init.zsh']))
    const old = generation(root, 'e', 10, ['init.zsh', '.zcompdump'])
    const withHistory = generation(root, 'f', 11, ['init.zsh', '.zsh_history'])
    mkdirSync(join(root, 'notes'))
    writeFileSync(join(root, '9'.repeat(32)), 'a file, not a generation')

    expect(sweepOldGenerations(root, [current], 3, owns)).toEqual([old])
    expect(existsSync(old)).toBe(false)
    for (const dir of [current, ...newest, withHistory]) expect(existsSync(dir)).toBe(true)
    expect(readdirSync(withHistory).sort()).toEqual(['.zsh_history', 'init.zsh'])
    expect(existsSync(join(root, 'notes'))).toBe(true)
    expect(existsSync(join(root, '9'.repeat(32)))).toBe(true)
  })

  it('does nothing when the folder is missing', () => {
    expect(
      sweepOldGenerations(join(tmpdir(), 'ostia-missing-generations'), [], 0, () => true),
    ).toEqual([])
  })
})
