import { describe, expect, it } from 'vitest'
import type { AgentResume } from '../../shared/agents/agentResume'
import { managerAgents, parseManagerSettings } from '../../shared/agents/managerSettings'
import {
  ManagerError,
  type ManagerOpenRequest,
  ManagerService,
  managerWindowId,
  parseOpenRequest,
} from './manager'

function service(initialResume: unknown = null) {
  const spawned: {
    paneId: string
    argv: string[]
    resume: AgentResume | null
    onExit: () => void
  }[] = []
  const store = { saved: initialResume }
  let next = 0
  const svc = new ManagerService({
    loadResume: () => store.saved,
    saveResume: (saved) => {
      store.saved = saved
    },
    agents: () => managerAgents(parseManagerSettings({ agents: { aider: ['aider', '--yes'] } })),
    createPane: async () => `p${++next}`,
    spawn: (req) => {
      spawned.push(req)
      return true
    },
  })
  return { svc, spawned, store }
}

const req = (agent: string, args: string[] = []): ManagerOpenRequest => ({
  agent,
  args,
  cwd: '/home/u',
  cols: 120,
  rows: 40,
})

describe('parseOpenRequest', () => {
  it('rejects a relative cwd, a bad agent name and non-string args', () => {
    const ok = { agent: 'claude', args: [], cwd: '/home/u', cols: 80, rows: 24 }
    expect(() => parseOpenRequest({ ...ok, cwd: 'rel' })).toThrow(ManagerError)
    expect(() => parseOpenRequest({ ...ok, agent: '../x' })).toThrow(ManagerError)
    expect(() => parseOpenRequest({ ...ok, args: [1] })).toThrow(ManagerError)
  })

  it('falls back to 80x24 for a bad size', () => {
    const parsed = parseOpenRequest({ agent: 'claude', cwd: '/', cols: 0, rows: 'x' })
    expect([parsed.cols, parsed.rows]).toEqual([80, 24])
  })
})

describe('ManagerService', () => {
  it('MGR-C17 starts the preset with the extra args appended as argv, never joined', async () => {
    const { svc, spawned } = service()
    await svc.open(req('aider', ['--model', '$(rm -rf ~)']))
    expect(spawned[0]?.argv).toEqual(['aider', '--yes', '--model', '$(rm -rf ~)'])
  })

  it('MGR-C9 attaches to the running manager when the same agent is asked for', async () => {
    const { svc, spawned } = service()
    const first = await svc.open(req('claude'))
    const second = await svc.open(req('claude'))
    expect(first.created).toBe(true)
    expect(second).toEqual({ info: first.info, created: false })
    expect(spawned).toHaveLength(1)
  })

  it('MGR-C10 refuses a different agent while a manager runs, naming the running one', async () => {
    const { svc } = service()
    await svc.open(req('claude'))
    await expect(svc.open(req('codex'))).rejects.toThrow(
      'manager-busy: the manager is running claude',
    )
  })

  it('MGR-C16 refuses an unknown agent and lists the presets', async () => {
    const { svc } = service()
    await expect(svc.open(req('nope'))).rejects.toThrow(/unknown-agent: nope \(known: .*claude/)
  })

  it('MGR-C23 starts a new manager after the agent exits', async () => {
    const { svc, spawned } = service()
    await svc.open(req('claude'))
    spawned[0]?.onExit()
    expect(svc.live).toBeNull()
    const again = await svc.open(req('codex'))
    expect(again.created).toBe(true)
    expect(again.info.paneId).toBe('p2')
  })

  it('MGR-C27 opens one manager when two requests race', async () => {
    const { svc, spawned } = service()
    const [a, b] = await Promise.all([svc.open(req('claude')), svc.open(req('claude'))])
    expect(spawned).toHaveLength(1)
    expect(a.info).toEqual(b.info)
  })

  it('MGR-C33 resumes the saved session after Ostia quit with the manager running', async () => {
    const first = service()
    await first.svc.open(req('claude'))
    first.svc.rememberResume({ agent: 'claude', id: 'sess-1' })
    first.svc.shutdown()
    first.spawned[0]?.onExit()
    expect(first.store.saved).toEqual({
      agent: 'claude',
      resume: { agent: 'claude', id: 'sess-1' },
    })

    const restarted = service(first.store.saved)
    await restarted.svc.open(req('claude'))
    expect(restarted.spawned[0]?.resume).toEqual({ agent: 'claude', id: 'sess-1' })
  })

  it('MGR-C33 starts fresh after the agent exits on its own', async () => {
    const { svc, spawned, store } = service()
    await svc.open(req('claude'))
    svc.rememberResume({ agent: 'claude', id: 'sess-1' })
    spawned[0]?.onExit()
    expect(store.saved).toBeNull()
    await svc.open(req('claude'))
    expect(spawned[1]?.resume).toBeNull()
  })

  it('MGR-C33 does not resume another preset, extra args, or a malformed saved token', async () => {
    const saved = { agent: 'claude', resume: { agent: 'claude', id: 'sess-1' } }
    const other = service(saved)
    await other.svc.open(req('codex'))
    expect(other.spawned[0]?.resume).toBeNull()
    const withArgs = service(saved)
    await withArgs.svc.open(req('claude', ['-p', 'x']))
    expect(withArgs.spawned[0]?.resume).toBeNull()
    const bad = service({ agent: 'claude', resume: { agent: 'claude', id: '$(rm)' } })
    await bad.svc.open(req('claude'))
    expect(bad.spawned[0]?.resume).toBeNull()
  })
})

describe('managerWindowId', () => {
  it('MGR-C38 opens the manager only in the main window, once that window is ready', () => {
    expect(managerWindowId('main', new Set(['detached', 'main']))).toBe('main')
    expect(managerWindowId('main', new Set(['detached']))).toBeNull()
    expect(managerWindowId(undefined, new Set(['detached']))).toBeNull()
  })
})
