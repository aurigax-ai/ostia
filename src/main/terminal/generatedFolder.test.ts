import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GENERATED_LIST,
  installGenerated,
  removeUntouchedGenerations,
  touchGenerated,
} from './generatedFolder'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const CUTOFF = NOW - 30 * DAY

let base: string
let root: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-generated-')))
  root = join(base, 'run', 'agents')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function write(files: Record<string, string>) {
  return (staging: string) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(staging, name)), { recursive: true })
      writeFileSync(join(staging, name), text)
    }
  }
}

function install(digest: string, files: Record<string, string>): string {
  return installGenerated(root, join(root, digest), Object.keys(files), write(files))
}

function age(dir: string, days: number): void {
  const when = new Date(NOW - days * DAY)
  utimesSync(dir, when, when)
}

const PLUGIN = {
  [join('claude-plugin', 'hooks', 'hooks.json')]: '{}',
  [join('codex', 'session-context.md')]: 'context',
}

describe('writing a generation', () => {
  it('lists the files it wrote inside the generation', () => {
    const dir = install('a'.repeat(32), PLUGIN)
    const listed = JSON.parse(readFileSync(join(dir, GENERATED_LIST), 'utf8'))
    expect(listed.sort()).toEqual(Object.keys(PLUGIN).sort())
  })

  it('adds the list to a complete generation written before lists existed', () => {
    const dir = join(root, 'b'.repeat(32))
    write(PLUGIN)(dir)
    expect(install('b'.repeat(32), PLUGIN)).toBe(dir)
    const listed = JSON.parse(readFileSync(join(dir, GENERATED_LIST), 'utf8'))
    expect(listed.sort()).toEqual(Object.keys(PLUGIN).sort())
  })
})

describe('removing untouched generations', () => {
  it('removes a generation untouched past the limit and keeps the current and recent ones', () => {
    const old = install('1'.repeat(32), PLUGIN)
    const current = install('2'.repeat(32), PLUGIN)
    const recent = install('3'.repeat(32), PLUGIN)
    age(old, 31)
    age(current, 90)
    age(recent, 29)
    const removed = removeUntouchedGenerations(root, new Set([current]), CUTOFF)
    expect(removed).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(current, 'codex', 'session-context.md'))).toBe(true)
    expect(existsSync(join(recent, 'codex', 'session-context.md'))).toBe(true)
  })

  it('keeps a generation that was touched again within the limit', () => {
    const dir = install('4'.repeat(32), PLUGIN)
    age(dir, 45)
    touchGenerated(dir, new Date(NOW - DAY))
    expect(removeUntouchedGenerations(root, new Set(), CUTOFF)).toEqual([])
    expect(existsSync(join(dir, 'claude-plugin', 'hooks', 'hooks.json'))).toBe(true)
  })

  it('leaves files Ostia did not write, and the folders that hold them', () => {
    const dir = install('5'.repeat(32), PLUGIN)
    writeFileSync(join(dir, 'claude-plugin', 'hooks', 'mine.sh'), 'user file')
    writeFileSync(join(dir, 'notes.txt'), 'user file')
    age(dir, 40)
    removeUntouchedGenerations(root, new Set(), CUTOFF)
    expect(readFileSync(join(dir, 'claude-plugin', 'hooks', 'mine.sh'), 'utf8')).toBe('user file')
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('user file')
    expect(existsSync(join(dir, 'claude-plugin', 'hooks', 'hooks.json'))).toBe(false)
    expect(existsSync(join(dir, 'codex'))).toBe(false)
    expect(existsSync(join(dir, GENERATED_LIST))).toBe(false)
  })

  it('leaves a generation that has no list of its files', () => {
    const dir = join(root, '6'.repeat(32))
    write(PLUGIN)(dir)
    age(dir, 40)
    expect(removeUntouchedGenerations(root, new Set(), CUTOFF)).toEqual([])
    expect(existsSync(join(dir, 'codex', 'session-context.md'))).toBe(true)
  })

  it('does not follow a folder inside the generation that became a symlink', () => {
    const outside = join(base, 'outside')
    mkdirSync(join(outside, 'hooks'), { recursive: true })
    writeFileSync(join(outside, 'hooks', 'hooks.json'), 'outside')
    const dir = install('7'.repeat(32), PLUGIN)
    rmSync(join(dir, 'claude-plugin'), { recursive: true })
    symlinkSync(outside, join(dir, 'claude-plugin'))
    age(dir, 40)
    removeUntouchedGenerations(root, new Set(), CUTOFF)
    expect(readFileSync(join(outside, 'hooks', 'hooks.json'), 'utf8')).toBe('outside')
  })

  it('does not follow listed names that climb out of the generation', () => {
    const outside = join(root, 'victim.txt')
    const dir = install('8'.repeat(32), PLUGIN)
    writeFileSync(outside, 'outside')
    writeFileSync(join(base, 'escape.txt'), 'outside')
    writeFileSync(
      join(dir, GENERATED_LIST),
      JSON.stringify([join('..', 'victim.txt'), join(base, 'escape.txt'), ...Object.keys(PLUGIN)]),
    )
    age(dir, 40)
    removeUntouchedGenerations(root, new Set(), CUTOFF)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
    expect(readFileSync(join(base, 'escape.txt'), 'utf8')).toBe('outside')
    expect(existsSync(dir)).toBe(false)
  })

  it('does not follow a generation that is a symlink to a folder elsewhere', () => {
    const outside = join(base, 'elsewhere')
    write(PLUGIN)(outside)
    writeFileSync(join(outside, GENERATED_LIST), JSON.stringify(Object.keys(PLUGIN)))
    mkdirSync(root, { recursive: true })
    const link = join(root, '9'.repeat(32))
    symlinkSync(outside, link)
    age(outside, 40)
    expect(removeUntouchedGenerations(root, new Set(), CUTOFF)).toEqual([])
    expect(existsSync(join(outside, 'codex', 'session-context.md'))).toBe(true)
    expect(existsSync(join(outside, GENERATED_LIST))).toBe(true)
  })

  it('does nothing when the generations folder itself is a symlink', () => {
    const real = join(base, 'real-root')
    mkdirSync(real)
    const dir = installGenerated(
      real,
      join(real, 'c'.repeat(32)),
      Object.keys(PLUGIN),
      write(PLUGIN),
    )
    age(dir, 40)
    mkdirSync(dirname(root), { recursive: true })
    symlinkSync(real, root)
    expect(removeUntouchedGenerations(root, new Set(), CUTOFF)).toEqual([])
    expect(existsSync(join(dir, 'codex', 'session-context.md'))).toBe(true)
  })

  it('skips staging folders and plain files beside the generations', () => {
    install('d'.repeat(32), PLUGIN)
    const staging = join(root, '.staging-left')
    mkdirSync(staging)
    writeFileSync(join(staging, GENERATED_LIST), '[]')
    writeFileSync(join(root, 'stray'), 'x')
    age(staging, 40)
    expect(removeUntouchedGenerations(root, new Set(), CUTOFF)).toEqual([])
    expect(existsSync(staging)).toBe(true)
    expect(statSync(join(root, 'stray')).isFile()).toBe(true)
  })
})

describe('unexpected errors', () => {
  it('passes on an error that is not a file system error', () => {
    expect(() => touchGenerated(undefined as unknown as string)).toThrow(TypeError)
  })
})
