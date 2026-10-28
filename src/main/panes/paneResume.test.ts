import { describe, expect, it } from 'vitest'
import type { AgentResume } from '../../shared/agents/agentResume'
import type { CommandResult } from '../../shared/control/commands'
import type { PaneIdentity } from '../control/idRegistry'
import { type PaneResumeDeps, refreshResumeFolder } from './paneResume'

const identity = {
  paneId: 'p1',
  windowId: 'w1',
  workspaceId: 's1',
  externalId: 'x1',
} as unknown as PaneIdentity

function setup(options: {
  stored: AgentResume | null
  processFolder?: string | null
  sessionFolder?: string | null
}) {
  const calls: { id: string; args: unknown }[] = []
  const resumed: AgentResume[] = []
  const deps: PaneResumeDeps = {
    execCommand: async (_target, id, args) => {
      calls.push({ id, args })
      return (
        id === 'pane.resumeToken' ? { ok: true, result: { resume: options.stored } } : { ok: true }
      ) as CommandResult
    },
    foregroundProgram: () => null,
    agentCwd: async () => options.processFolder ?? null,
    sessionFolder: () => options.sessionFolder ?? null,
    onResume: (_identity, resume) => resumed.push(resume),
  }
  return { deps, calls, resumed }
}

const setCalls = (calls: { id: string; args: unknown }[]) =>
  calls.filter((c) => c.id === 'resume.set').map((c) => c.args)

describe('refreshResumeFolder', () => {
  it('moves a Claude token to the worktree the session entered, keeping its flags, starting no session', async () => {
    const { deps, calls, resumed } = setup({
      stored: { agent: 'claude', id: 'a', cwd: '/w/repo', args: ['--model', 'opus'] },
      processFolder: '/w/repo/.claude/worktrees/wt1',
    })
    await refreshResumeFolder(deps, identity)
    expect(setCalls(calls)).toEqual([
      {
        agent: 'claude',
        id: 'a',
        cwd: '/w/repo/.claude/worktrees/wt1',
        args: ['--model', 'opus'],
      },
    ])
    expect(resumed).toEqual([])
  })

  it('moves a Codex token to the folder its own record names after /cd, not the process folder', async () => {
    const { deps, calls } = setup({
      stored: { agent: 'codex', id: 'c', cwd: '/w/a' },
      processFolder: '/w/a',
      sessionFolder: '/w/b',
    })
    await refreshResumeFolder(deps, identity)
    expect(setCalls(calls)).toEqual([{ agent: 'codex', id: 'c', cwd: '/w/b' }])
  })

  it('changes nothing without a token, with the same folder or with no folder known', async () => {
    for (const options of [
      { stored: null, processFolder: '/w/x' },
      { stored: { agent: 'claude' as const, id: 'a', cwd: '/w/x' }, processFolder: '/w/x' },
      { stored: { agent: 'claude' as const, id: 'a', cwd: '/w/x' }, processFolder: null },
    ]) {
      const { deps, calls } = setup(options)
      await refreshResumeFolder(deps, identity)
      expect(setCalls(calls)).toEqual([])
    }
  })
})
