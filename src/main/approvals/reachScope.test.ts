import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type WorkspaceSandbox, emptyWorkspaceSandbox } from '../../shared/sandbox/sandbox'
import {
  AgentProvenance,
  type ScopeWorkspace,
  projectKey,
  sameReachScope,
  unconfirmedMembers,
} from './reachScope'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'reach-home-')))

function repo(name: string): string {
  const dir = join(home, name)
  mkdirSync(join(dir, '.git', 'worktrees'), { recursive: true })
  return dir
}

function worktree(main: string, name: string): string {
  const dir = join(home, name)
  const gitDir = join(main, '.git', 'worktrees', name)
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(gitDir, 'commondir'), '../..\n')
  writeFileSync(join(dir, '.git'), `gitdir: ${gitDir}\n`)
  return dir
}

const terminal = repo('terminal')
const terminalWorkers = worktree(terminal, 'terminal-workers')
const other = repo('other')
const plain = join(home, 'notes')
mkdirSync(join(terminal, 'src'), { recursive: true })
mkdirSync(plain, { recursive: true })

const SANDBOXED: WorkspaceSandbox = { ...emptyWorkspaceSandbox(), enabled: true }

function ws(id: string, over: Partial<ScopeWorkspace> = {}): ScopeWorkspace {
  return {
    id,
    shareable: true,
    project: projectKey(terminal, home),
    folderByAgent: false,
    sandbox: emptyWorkspaceSandbox(),
    group: null,
    ...over,
  }
}

describe('projectKey', () => {
  it('gives every worktree of a repository the same key, from its shared git dir', () => {
    expect(projectKey(terminal, home)).toBe(`git:${join(terminal, '.git')}`)
    expect(projectKey(terminalWorkers, home)).toBe(projectKey(terminal, home))
    expect(projectKey(join(terminal, 'src'), home)).toBe(projectKey(terminal, home))
  })

  it('gives a different repository a different key', () => {
    expect(projectKey(other, home)).not.toBe(projectKey(terminal, home))
  })

  it('falls back to the folder itself outside a repository, with ~ expanded', () => {
    expect(projectKey(plain, home)).toBe(`dir:${plain}`)
    expect(projectKey('~/notes', home)).toBe(`dir:${plain}`)
  })

  it('never makes the home folder, a folder above it, or a relative path a project', () => {
    expect(projectKey(home, home)).toBeNull()
    expect(projectKey('~', home)).toBeNull()
    expect(projectKey('/', home)).toBeNull()
    expect(projectKey('notes', home)).toBeNull()
  })

  it('does not climb into a repository at the home folder itself', () => {
    mkdirSync(join(home, '.git'), { recursive: true })
    expect(projectKey(plain, home)).toBe(`dir:${plain}`)
  })
})

describe('sameReachScope', () => {
  const a = ws('a')
  const b = ws('b', { project: projectKey(terminalWorkers, home) })

  it('workspace: only the caller’s own workspace', () => {
    expect(sameReachScope(a, a, 'workspace')).toBe(true)
    expect(sameReachScope(a, b, 'workspace')).toBe(false)
  })

  it('project: two worktrees of one repository are one scope', () => {
    expect(sameReachScope(a, b, 'project')).toBe(true)
  })

  it('project: a different repository or a different plain folder is not', () => {
    expect(sameReachScope(a, ws('c', { project: projectKey(other, home) }), 'project')).toBe(false)
    expect(sameReachScope(ws('d', { project: null }), ws('e', { project: null }), 'project')).toBe(
      false,
    )
  })

  it('project: a sandboxed caller or target, or a different sandbox, is never shared', () => {
    expect(sameReachScope(ws('s', { sandbox: SANDBOXED }), b, 'project')).toBe(false)
    expect(sameReachScope(a, ws('s', { sandbox: SANDBOXED }), 'project')).toBe(false)
    expect(
      sameReachScope(ws('s1', { sandbox: SANDBOXED }), ws('s2', { sandbox: SANDBOXED }), 'project'),
    ).toBe(false)
  })

  it('a scratch or manager workspace is never shared, in any mode', () => {
    for (const mode of ['project', 'group'] as const) {
      const grouped = { id: 'g1', byAgent: false }
      const scratch = ws('scratch', { shareable: false, group: grouped })
      expect(sameReachScope(ws('a', { group: grouped }), scratch, mode)).toBe(false)
      expect(sameReachScope(scratch, ws('a', { group: grouped }), mode)).toBe(false)
    }
  })

  it('group: workspaces the human put in one group are one scope, whatever their project', () => {
    const g = { id: 'g1', byAgent: false }
    const caller = ws('a', { group: g })
    const target = ws('c', { group: g, project: projectKey(other, home) })
    expect(sameReachScope(caller, target, 'group')).toBe(true)
    expect(sameReachScope(caller, ws('d', { group: { id: 'g2', byAgent: false } }), 'group')).toBe(
      false,
    )
    expect(sameReachScope(caller, ws('e'), 'group')).toBe(false)
  })

  it('group: a membership an agent made gives no reach until it is confirmed', () => {
    const caller = ws('a', { group: { id: 'g1', byAgent: false } })
    const target = ws('c', { group: { id: 'g1', byAgent: true } })
    expect(sameReachScope(caller, target, 'group')).toBe(false)
    expect(sameReachScope(target, caller, 'group')).toBe(false)
    expect(unconfirmedMembers(caller, target, 'group')).toEqual(['c'])
    expect(unconfirmedMembers(caller, target, 'project')).toEqual([])
  })

  it('project: a workspace whose folder an agent set is not shared until it is confirmed', () => {
    const moved = ws('m', { folderByAgent: true })
    expect(sameReachScope(a, moved, 'project')).toBe(false)
    expect(sameReachScope(moved, a, 'project')).toBe(false)
    expect(unconfirmedMembers(a, moved, 'project')).toEqual(['m'])
    expect(
      unconfirmedMembers(a, ws('x', { folderByAgent: true, project: null }), 'project'),
    ).toEqual([])
    expect(sameReachScope(moved, moved, 'project')).toBe(true)
  })

  it('group: nothing to confirm when the pair could not share a scope anyway', () => {
    const caller = ws('a', { group: { id: 'g1', byAgent: false } })
    const sandboxed = ws('c', { group: { id: 'g1', byAgent: true }, sandbox: SANDBOXED })
    expect(unconfirmedMembers(caller, sandboxed, 'group')).toEqual([])
  })
})

describe('AgentProvenance', () => {
  it('counts a membership as the agent’s until the human confirms it or moves the workspace', () => {
    const p = new AgentProvenance()
    p.setByAgent('w1', 'g1')
    expect(p.byAgent('w1', 'g1')).toBe(true)
    expect(p.byAgent('w1', 'g2')).toBe(false)
    p.confirm('w1')
    expect(p.byAgent('w1', 'g1')).toBe(false)
  })
})
