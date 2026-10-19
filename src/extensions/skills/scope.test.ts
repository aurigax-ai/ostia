import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderScope, normalizeRemote, scopeApplies } from './scope'

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })

describe('normalizeRemote', () => {
  it('makes ssh, https and .git forms equal', () => {
    const want = 'github.com/aurigax-ai/ostia'
    expect(normalizeRemote('git@github.com:aurigax-ai/ostia.git')).toBe(want)
    expect(normalizeRemote('https://github.com/Aurigax-AI/Ostia.git')).toBe(want)
    expect(normalizeRemote('ssh://git@github.com/aurigax-ai/ostia')).toBe(want)
  })

  it('refuses text that is not a remote', () => {
    expect(normalizeRemote('not a url')).toBeNull()
    expect(normalizeRemote('https://github.com/solo')).toBeNull()
  })
})

describe('folderScope', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-skills-scope-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const repo = (name: string, remote?: string) => {
    const dir = join(root, name)
    mkdirSync(dir)
    git(dir, 'init', '-q')
    if (remote) git(dir, 'remote', 'add', 'origin', remote)
    return dir
  }

  it('shares project rules between a clone and a worktree through the remote', async () => {
    const main = repo('main', 'git@github.com:a/b.git')
    git(
      main,
      '-c',
      'user.email=a@b.c',
      '-c',
      'user.name=n',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    )
    const tree = join(root, 'tree')
    git(main, 'worktree', 'add', '-q', tree)
    const clone = repo('clone', 'https://github.com/a/b')
    const rule = 'project:github.com/a/b'
    for (const dir of [main, tree, clone]) {
      expect(scopeApplies(rule, await folderScope(dir))).toBe(true)
    }
    expect(scopeApplies('project:github.com/a/c', await folderScope(main))).toBe(false)
  })

  it('falls back to the real git root path without a remote', async () => {
    const dir = repo('local')
    mkdirSync(join(dir, 'src'))
    const where = await folderScope(join(dir, 'src'))
    expect(where.projectKeys).toEqual([dir])
    expect(scopeApplies(`project:${dir}`, where)).toBe(true)
  })

  it('uses the folder itself outside a repository and reads the stack from its files', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    writeFileSync(join(dir, 'Cargo.toml'), '')
    writeFileSync(join(dir, 'go.mod'), '')
    const where = await folderScope(dir)
    expect(where.projectKeys).toEqual([dir])
    expect(where.stacks).toEqual(['rust', 'go'])
    expect(scopeApplies('stack:rust', where)).toBe(true)
    expect(scopeApplies('stack:node', where)).toBe(false)
    expect(scopeApplies('global', where)).toBe(true)
  })
})
