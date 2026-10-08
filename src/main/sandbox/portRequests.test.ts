import { describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '../../shared/approvals'
import type { PortsPolicy } from '../../shared/sandbox'
import type { ExposeRefusal, ExposeResult, SandboxListener } from './portForwarder'
import { PortRequests } from './portRequests'

function setup(
  opts: {
    platform?: NodeJS.Platform
    policy?: PortsPolicy
    outcome?: ApprovalOutcome
    refusal?: ExposeRefusal
  } = {},
) {
  const asks: number[] = []
  const exposed = new Set<number>()
  let listeners: SandboxListener[] = []
  const requests = new PortRequests({
    platform: opts.platform ?? 'linux',
    isSandboxed: () => true,
    policy: () => opts.policy ?? 'ask',
    ask: async ({ port }) => {
      asks.push(port)
      return opts.outcome ?? 'workspace'
    },
    forwarder: {
      listeners: () => listeners,
      exposed: () => [...exposed],
      refusal: () => opts.refusal ?? null,
      expose: async (_ws, port): Promise<ExposeResult> => {
        exposed.add(port)
        return { ok: true, port }
      },
      unexpose: async (_ws, port) => {
        exposed.delete(port)
      },
    },
  })
  return {
    requests,
    asks,
    exposed,
    listen: (list: SandboxListener[]) => {
      listeners = list
    },
  }
}

describe('PortRequests', () => {
  it('SBX-C48 refuses a port outside 1024–65535 or not a number, without a card', async () => {
    const { requests, asks } = setup()
    for (const port of ['80', '0', '70000', 'abc', '3000.5']) {
      await expect(requests.request('ws', 'pane', port)).resolves.toMatchObject({
        ok: false,
        error: 'invalid-port',
      })
    }
    expect(asks).toEqual([])
  })

  it('SBX-C49 tells an agent on macOS that forwarding is not needed, without a card', async () => {
    const { requests, asks, exposed } = setup({ platform: 'darwin' })
    await expect(requests.request('ws', 'pane', '3000')).resolves.toEqual({
      ok: true,
      port: 3000,
      notice: 'not-needed-on-macos',
    })
    expect(asks).toEqual([])
    expect(exposed.size).toBe(0)
  })

  it('SBX-C63 asks about a new listener when ports.policy is ask, and exposes it on approval', async () => {
    const { requests, asks, exposed, listen } = setup({ policy: 'ask' })
    listen([{ port: 5173, process: 'node' }])
    await requests.scan('ws')
    expect(asks).toEqual([5173])
    expect([...exposed]).toEqual([5173])
    expect(requests.ports('ws')).toEqual([{ port: 5173, process: 'node', exposed: true }])
    await requests.scan('ws')
    expect(asks).toEqual([5173])
  })

  it('SBX-C64 exposes a new listener without a card when ports.policy is allow', async () => {
    const { requests, asks, exposed, listen } = setup({ policy: 'allow' })
    listen([{ port: 5173, process: 'node' }])
    await requests.scan('ws')
    expect(asks).toEqual([])
    expect([...exposed]).toEqual([5173])
  })

  it('SBX-C65 does nothing for a new listener when ports.policy is deny, but the human can expose it', async () => {
    const { requests, asks, exposed, listen } = setup({ policy: 'deny' })
    listen([{ port: 5173, process: 'node' }])
    await requests.scan('ws')
    expect(asks).toEqual([])
    expect(exposed.size).toBe(0)
    await expect(requests.exposeByHuman('ws', 5173)).resolves.toEqual({ ok: true, port: 5173 })
    expect([...exposed]).toEqual([5173])
  })

  it('SBX-C66 drops an exposed port from the list and releases it when its process exits', async () => {
    const { requests, exposed, listen } = setup({ policy: 'allow' })
    listen([{ port: 5173, process: 'node' }])
    await requests.scan('ws')
    listen([])
    await requests.scan('ws')
    expect(exposed.size).toBe(0)
    expect(requests.ports('ws')).toEqual([])
  })

  it('answers an agent that Unix sockets are off without a card', async () => {
    const { requests, asks, exposed } = setup({ refusal: 'unix-sockets-off' })
    await expect(requests.request('ws', 'pane', '3000')).resolves.toEqual({
      ok: false,
      error: 'unix-sockets-off',
    })
    expect(asks).toEqual([])
    expect(exposed.size).toBe(0)
  })

  it('shows no card for a new listener while its port cannot be forwarded', async () => {
    for (const policy of ['ask', 'allow'] as const) {
      const { requests, asks, exposed, listen } = setup({ policy, refusal: 'unix-sockets-off' })
      listen([{ port: 5173, process: 'node' }])
      await requests.scan('ws')
      expect(asks).toEqual([])
      expect(exposed.size).toBe(0)
      expect(requests.ports('ws')).toEqual([{ port: 5173, process: 'node', exposed: false }])
    }
  })

  it('does not ask again about a listener whose port is already exposed, as after a restart', async () => {
    const { requests, asks, exposed, listen } = setup({ policy: 'ask' })
    exposed.add(3000)
    listen([{ port: 3000, process: 'node' }])
    await requests.scan('ws')
    expect(asks).toEqual([])
    expect([...exposed]).toEqual([3000])
  })

  it('KSH-C58 exposes a kept port again without asking while the same program listens on it', async () => {
    const { requests, asks, exposed, listen } = setup({ policy: 'ask' })
    requests.keep('ws', [{ port: 3000, process: 'node', pid: 41 }])
    listen([{ port: 3000, process: 'node', pid: 41 }])
    await requests.scan('ws')
    expect(asks).toEqual([])
    expect([...exposed]).toEqual([3000])
  })

  it('asks again about a kept port whose server stopped and started again', async () => {
    const { requests, asks, listen } = setup({ policy: 'ask' })
    requests.keep('ws', [{ port: 3000, process: 'node', pid: 41 }])
    listen([{ port: 3000, process: 'node', pid: 41 }])
    await requests.scan('ws')
    listen([])
    await requests.scan('ws')
    listen([{ port: 3000, process: 'node', pid: 41 }])
    await requests.scan('ws')
    expect(asks).toEqual([3000])
  })

  it('KSH-C76 asks again about a kept port when another program listens on it now', async () => {
    for (const listener of [
      { port: 3000, process: 'python3', pid: 41 },
      { port: 3000, process: 'node', pid: 77 },
    ]) {
      const { requests, asks, exposed, listen } = setup({ policy: 'ask', outcome: 'deny' })
      requests.keep('ws', [{ port: 3000, process: 'node', pid: 41 }])
      listen([listener])
      await requests.scan('ws')
      expect(asks).toEqual([3000])
      expect(exposed.size).toBe(0)
    }
  })

  it('KSH-C77 restores a kept port under the deny policy only when the human exposed it', async () => {
    const byAgent = setup({ policy: 'deny' })
    byAgent.requests.keep('ws', [{ port: 3000, process: 'node', pid: 41 }])
    byAgent.listen([{ port: 3000, process: 'node', pid: 41 }])
    await byAgent.requests.scan('ws')
    expect(byAgent.exposed.size).toBe(0)
    expect(byAgent.asks).toEqual([])

    const byHuman = setup({ policy: 'deny' })
    byHuman.requests.keep('ws', [{ port: 3000, process: 'node', pid: 41, byHuman: true }])
    byHuman.listen([{ port: 3000, process: 'node', pid: 41 }])
    await byHuman.requests.scan('ws')
    expect([...byHuman.exposed]).toEqual([3000])
    expect(byHuman.requests.exposures('ws')).toEqual([
      { port: 3000, process: 'node', pid: 41, byHuman: true },
    ])
  })

  it('waits to restore a kept port until it can be forwarded, then drops kept ports nobody listens on', async () => {
    let refusal: 'not-running' | null = 'not-running'
    const exposed = new Set<number>()
    let listeners: SandboxListener[] = [{ port: 3000, process: 'node', pid: 41 }]
    const asks: number[] = []
    const requests = new PortRequests({
      platform: 'linux',
      isSandboxed: () => true,
      policy: () => 'ask',
      ask: async ({ port }) => {
        asks.push(port)
        return 'workspace'
      },
      forwarder: {
        listeners: () => listeners,
        exposed: () => [...exposed],
        refusal: () => refusal,
        expose: async (_ws, port): Promise<ExposeResult> => {
          exposed.add(port)
          return { ok: true, port }
        },
        unexpose: async (_ws, port) => {
          exposed.delete(port)
        },
      },
    })
    requests.keep('ws', [
      { port: 3000, process: 'node', pid: 41 },
      { port: 4000, process: 'node', pid: 42 },
    ])
    await requests.scan('ws')
    expect(exposed.size).toBe(0)
    refusal = null
    await requests.scan('ws')
    expect([...exposed]).toEqual([3000])
    expect(asks).toEqual([])
    listeners = [...listeners, { port: 4000, process: 'node', pid: 42 }]
    await requests.scan('ws')
    expect(asks).toEqual([4000])
  })

  it('records the program serving an exposed port from listeners read now, before a scan saw it', async () => {
    const { requests } = setup({ policy: 'ask' })
    await requests.exposeByHuman('ws', 3000)
    expect(requests.exposures('ws')).toEqual([])
    expect(requests.exposures('ws', [{ port: 3000, process: 'node', pid: 41 }])).toEqual([
      { port: 3000, process: 'node', pid: 41, byHuman: true },
    ])
  })

  it('records what program serves each exposed port and whether the human exposed it', async () => {
    const { requests, listen } = setup({ policy: 'allow' })
    listen([
      { port: 3000, process: 'node', pid: 41 },
      { port: 4000, process: null },
    ])
    await requests.scan('ws')
    await requests.exposeByHuman('ws', 5000)
    expect(requests.exposures('ws')).toEqual([{ port: 3000, process: 'node', pid: 41 }])
    listen([
      { port: 3000, process: 'node', pid: 41 },
      { port: 5000, process: 'vite', pid: 50 },
    ])
    await requests.scan('ws')
    expect(requests.exposures('ws')).toEqual([
      { port: 3000, process: 'node', pid: 41 },
      { port: 5000, process: 'vite', pid: 50, byHuman: true },
    ])
  })
})
