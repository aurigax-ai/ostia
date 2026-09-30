import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutableIndex, commandNames, pathDirs, readShellState } from './shellCommands'

let root = ''

function file(dir: string, name: string, mode: number): string {
  const path = join(dir, name)
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, mode)
  return path
}

function touchDir(dir: string, seconds: number): void {
  utimesSync(dir, seconds, seconds)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pine-path-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readShellState', () => {
  it('reads the PATH from the first line and the command names after it', async () => {
    const state = join(root, 'state')
    writeFileSync(state, '/a b:/c\ncd  if\tll \n')
    expect(await readShellState(state)).toEqual({ path: '/a b:/c', names: ['cd', 'if', 'll'] })
  })

  it('reads nothing from a missing, symlinked, oversized or malformed file', async () => {
    expect(await readShellState(join(root, 'missing'))).toBeNull()
    const real = join(root, 'real')
    writeFileSync(real, '/usr/bin\nls\n')
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(await readShellState(link)).toBeNull()
    const big = join(root, 'big')
    writeFileSync(big, `/usr/bin\n${'x'.repeat(2 * 1024 * 1024)}`)
    expect(await readShellState(big)).toBeNull()
    const noNewline = join(root, 'partial')
    writeFileSync(noNewline, '/usr/bin')
    expect(await readShellState(noNewline)).toBeNull()
  })
})

describe('pathDirs', () => {
  it('keeps absolute directories once and drops relative or empty entries', () => {
    expect(pathDirs('/usr/bin::.:bin:/usr/bin:/opt/x', ':')).toEqual(['/usr/bin', '/opt/x'])
  })
})

describe('ExecutableIndex', () => {
  it('lists only executable files from the PATH directories, never their contents', async () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    file(a, 'tool', 0o755)
    file(a, 'notes.txt', 0o644)
    mkdirSync(join(a, 'subdir'))
    const target = file(b, 'real', 0o700)
    symlinkSync(target, join(b, 'linked'))
    symlinkSync(join(root, 'missing'), join(b, 'dangling'))
    const index = new ExecutableIndex(':')
    expect(await index.list(`${a}:${b}:relative:${join(root, 'absent')}`)).toEqual([
      'linked',
      'real',
      'tool',
    ])
  })

  it('serves a PATH from the cache until one of its directories changes', async () => {
    const dir = join(root, 'bin')
    mkdirSync(dir)
    file(dir, 'first', 0o755)
    const later = file(dir, 'later', 0o644)
    touchDir(dir, 1_000)
    const index = new ExecutableIndex(':')
    expect(await index.list(dir)).toEqual(['first'])

    chmodSync(later, 0o755)
    expect(await index.list(dir)).toEqual(['first'])

    file(dir, 'added', 0o755)
    touchDir(dir, 2_000)
    expect(await index.list(dir)).toEqual(['added', 'first', 'later'])
  })

  it('keeps a separate listing per PATH string', async () => {
    const one = join(root, 'one')
    const two = join(root, 'two')
    mkdirSync(one)
    mkdirSync(two)
    file(one, 'alpha', 0o755)
    file(two, 'beta', 0o755)
    const index = new ExecutableIndex(':')
    expect(await index.list(one)).toEqual(['alpha'])
    expect(await index.list(`${one}:${two}`)).toEqual(['alpha', 'beta'])
    expect(await index.list(two)).toEqual(['beta'])
  })
})

describe('commandNames', () => {
  it('merges PATH executables with the names the shell reported, sorted and unique', async () => {
    const dir = join(root, 'bin')
    mkdirSync(dir)
    file(dir, 'git', 0o755)
    file(dir, 'echo', 0o755)
    const names = await commandNames(new ExecutableIndex(':'), dir, ['echo', 'cd', 'll'])
    expect(names).toEqual(['cd', 'echo', 'git', 'll'])
  })
})
