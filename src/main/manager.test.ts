import { describe, expect, it } from 'vitest'
import {
  ManagerError,
  type ManagerOpenRequest,
  ManagerService,
  parseManagerAgents,
  parseOpenRequest,
} from './manager'

function service() {
  const spawned: { paneId: string; argv: string[]; onExit: () => void }[] = []
  let next = 0
  const svc = new ManagerService({
    agents: () => parseManagerAgents({ manager: { agents: { aider: ['aider', '--yes'] } } }),
    createPane: async () => `p${++next}`,
    spawn: (req) => {
      spawned.push(req)
      return true
    },
  })
  return { svc, spawned }
}

const req = (agent: string, args: string[] = []): ManagerOpenRequest => ({
  agent,
  args,
  cwd: '/home/u',
  cols: 120,
  rows: 40,
})

describe('parseManagerAgents', () => {
  it('MGR-C16 keeps the built-in presets and adds valid ones from settings', () => {
    const agents = parseManagerAgents({
      manager: { agents: { aider: ['aider'], 'bad name': ['x'], empty: [], num: [1] } },
    })
    expect(Object.keys(agents).sort()).toEqual(['aider', 'claude', 'codex'])
  })

  it('MGR-C16 ignores settings without a manager section', () => {
    expect(Object.keys(parseManagerAgents(undefined)).sort()).toEqual(['claude', 'codex'])
  })
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
})
