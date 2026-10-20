import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppliedStore } from './appliedStore'
import { EvalStore } from './evalStore'
import { HOLDOUT_SHARE, skillsService } from './service'
import { SignalStore } from './signalStore'
import { RulesStore } from './store'

const where = { projectKeys: ['github.com/a/b'], stacks: [] as string[] }
const caller = (extra: Partial<ExtensionCaller> = {}) =>
  ({
    kind: 'pane',
    paneId: 'p1',
    workspaceId: 'w1',
    workDir: '/w',
    cwd: '/w',
    capabilities: [],
    ...extra,
  }) as ExtensionCaller
const start = (session: unknown = 'sess-1') => ({
  argv: ['claude', 'SessionStart'],
  stdin: JSON.stringify({ session_id: session }),
})

const data = <T>(res: ExtensionResult): T => (res as { data: T }).data

describe('applied sessions, the holdout and the scoreboard', () => {
  let store: RulesStore
  let applied: AppliedStore
  let holdout: boolean
  let draws: number[]
  let service: ReturnType<typeof skillsService>

  beforeEach(() => {
    store = new RulesStore(null, () => 1000)
    applied = new AppliedStore(null, () => 1000)
    holdout = false
    draws = []
    service = skillsService({
      store,
      signals: new SignalStore(null, () => 1000),
      applied,
      evals: new EvalStore(null),
      complete: async () => ({ ok: false, error: 'no-model' }),
      now: () => 1000,
      holdout: () => holdout,
      random: () => draws.shift() ?? 0.99,
      redact: async (texts) => texts,
      confirmDelete: async () => true,
      workspace: async (id) =>
        id === 'sc' ? { kind: 'scratch', workDir: '/w' } : { kind: 'terminal', workDir: '/w' },
      folderScopeOf: async () => where,
      changed: () => {},
    })
    store.add({ rule: 'Write no comments.', why: '', when: '', scope: 'global' }, 'human')
    store.add({ rule: 'Keep diffs small.', why: '', when: '', scope: 'global' }, 'human')
  })

  const text = async (args: unknown, c = caller()) =>
    ((await service.onSession(args, c)) as { text?: string }).text ?? ''

  it('records which rules a session was given', async () => {
    expect(await text(start())).toContain('[r1]')
    expect(applied.list()).toEqual([
      { at: 1000, session: 'sess-1', workspace: 'w1', rules: ['r1', 'r2'], held: [] },
    ])
  })

  it('records nothing without a usable session id, for a denied caller, or when no rule applies', async () => {
    await text(start(''))
    await text(start('bad id\n'))
    await text({ argv: ['claude', 'SessionStart'], stdin: 'not json' })
    await text(undefined)
    await text(start(), caller({ sandboxed: true }))
    await text(start(), caller({ workspaceId: 'sc' }))
    store.setState('r1', 'retired')
    store.setState('r2', 'retired')
    await text(start('sess-2'))
    expect(applied.list()).toEqual([])
  })

  it('does not record a preview', async () => {
    await service.panel.preview({}, caller())
    expect(applied.list()).toEqual([])
  })

  it('gives every rule when the holdout is off, whatever the dice say', async () => {
    draws = [0, 0, 0]
    expect(await text(start())).toContain('[r2]')
    expect(applied.list()[0].held).toEqual([])
  })

  it('leaves a rule out when the holdout is on and its draw falls under the share, and says so', async () => {
    holdout = true
    draws = [HOLDOUT_SHARE - 0.01, HOLDOUT_SHARE]
    const injected = await text(start())
    expect(injected).not.toContain('[r1]')
    expect(injected).toContain('[r2]')
    expect(applied.list()[0]).toMatchObject({ rules: ['r2'], held: ['r1'] })
  })

  it('records a session that left every rule out', async () => {
    holdout = true
    draws = [0, 0]
    expect(await text(start())).toBe('')
    expect(applied.list()[0]).toMatchObject({ rules: [], held: ['r1', 'r2'] })
  })

  it('answers the scoreboard for the active rules', async () => {
    store.setState('r2', 'retired')
    await text(start())
    const board = data<{ scores: { id: string; applied: number }[] }>(
      await service.panel.scoreboard({}, caller()),
    )
    expect(board.scores).toMatchObject([{ id: 'r1', applied: 1 }])
  })
})
