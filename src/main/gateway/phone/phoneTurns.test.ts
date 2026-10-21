import { afterAll, describe, expect, it, vi } from 'vitest'
import { registerPane, removePane } from '../../control/idRegistry'
import type { WorkspaceEntry } from '../../panes/paneList'
import { PaneTurns } from '../../panes/paneTurns'
import { type PhoneTurnDeps, TURN_LIST_MAX, turnList, turnOutput } from './phoneTurns'

const workspaces: WorkspaceEntry[] = [
  { workspaceId: 'w1', name: 'One', kind: 'agent', workDir: '/work/one', state: 'idle' },
  { workspaceId: 'pad', name: 'Pad', kind: 'scratch', workDir: '/s', state: 'idle' },
  { workspaceId: 'box', name: 'Box', kind: 'agent', workDir: '/b', state: 'idle', sandboxed: true },
]
const agent = registerPane({ windowId: 'win', workspaceId: 'w1', paneId: 'pt-agent' })
const scratch = registerPane({ windowId: 'win', workspaceId: 'pad', paneId: 'pt-pad' })
const boxed = registerPane({ windowId: 'win', workspaceId: 'box', paneId: 'pt-box' })
const remote = registerPane({ windowId: 'win', workspaceId: 'w1', paneId: 'pt-remote' })

afterAll(() => {
  for (const pane of ['pt-agent', 'pt-pad', 'pt-box', 'pt-remote']) removePane(pane)
})

function setup(
  redact: PhoneTurnDeps['redact'] = async (text) => text.replace('hunter2', '[REDACTED]'),
) {
  const paneTurns = new PaneTurns(() => 5)
  const deps: PhoneTurnDeps = {
    listWorkspaces: async () => workspaces,
    paneTurns,
    redact: vi.fn(redact),
    remote: (paneId: string) => paneId === 'pt-remote',
  }
  return { paneTurns, deps }
}

describe('turn.list and turn.output', () => {
  it('PHT-C9 sends an agent pane its turns with every text redacted and paths made relative', async () => {
    const { paneTurns, deps } = setup()
    paneTurns.report('pt-agent', { kind: 'prompt', text: 'use token hunter2' })
    paneTurns.report('pt-agent', { kind: 'step', step: 'edit', target: '/work/one/src/a.ts' })
    paneTurns.report('pt-agent', { kind: 'step', step: 'read', target: '/home/me/.ssh/config' })
    paneTurns.report('pt-agent', {
      kind: 'step',
      step: 'command',
      target: 'echo hunter2',
      exitCode: 0,
      output: 'hunter2 printed',
    })
    paneTurns.report('pt-agent', { kind: 'stop', message: 'Done with hunter2.' })

    const res = await turnList({ paneId: agent.externalId }, deps)
    expect(res).toEqual({
      ok: true,
      result: {
        truncated: false,
        turns: [
          {
            id: 't1',
            startedAt: 5,
            prompt: 'use token [REDACTED]',
            steps: [
              { id: 't1s1', kind: 'edit', target: 'src/a.ts', output: false },
              { id: 't1s2', kind: 'read', target: '…/config', output: false },
              { id: 't1s3', kind: 'command', target: 'echo [REDACTED]', exitCode: 0, output: true },
            ],
            final: 'Done with [REDACTED].',
            commands: 1,
            filesEdited: 1,
            ended: true,
          },
        ],
      },
    })
    expect(await turnOutput({ paneId: agent.externalId, stepId: 't1s3' }, deps)).toEqual({
      ok: true,
      result: { output: '[REDACTED] printed' },
    })
    expect(await turnOutput({ paneId: agent.externalId, stepId: 't1s1' }, deps)).toMatchObject({
      ok: false,
      message: 'unknown-step',
    })
  })

  it('PHT-C10 refuses scratch, sandboxed, remote, unknown and missing panes', async () => {
    const { deps } = setup()
    for (const [paneId, message] of [
      [scratch.externalId, 'unknown-pane'],
      [boxed.externalId, 'unknown-pane'],
      [remote.externalId, 'unknown-pane'],
      ['nope', 'not-an-agent'],
      [undefined, 'missing paneId'],
    ] as const) {
      expect(await turnList({ paneId }, deps)).toEqual({ ok: false, code: -32602, message })
    }
  })

  it('PHT-C11 sends nothing when redaction fails', async () => {
    const { paneTurns, deps } = setup(async () => {
      throw new Error('scanner down')
    })
    paneTurns.report('pt-agent', { kind: 'prompt', text: 'hello there' })
    paneTurns.report('pt-agent', { kind: 'step', step: 'command', target: 'ls', output: 'files' })
    expect(await turnList({ paneId: agent.externalId }, deps)).toEqual({
      ok: false,
      code: -32603,
      message: 'redaction-failed',
    })
    expect(await turnOutput({ paneId: agent.externalId, stepId: 't1s1' }, deps)).toEqual({
      ok: false,
      code: -32603,
      message: 'redaction-failed',
    })
  })

  it('PHT-C12 answers at most the newest 20 turns and says when older ones were left out', async () => {
    const { paneTurns, deps } = setup()
    for (let i = 0; i < TURN_LIST_MAX + 3; i++) {
      paneTurns.report('pt-agent', { kind: 'prompt', text: `job ${i}` })
    }
    const res = (await turnList({ paneId: agent.externalId }, deps)) as {
      result: { turns: { prompt: string }[]; truncated: boolean }
    }
    expect(res.result.turns).toHaveLength(TURN_LIST_MAX)
    expect(res.result.turns[0].prompt).toBe('job 3')
    expect(res.result.truncated).toBe(true)
  })
})
