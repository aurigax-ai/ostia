import { afterEach, describe, expect, it, vi } from 'vitest'
import { grant } from '../approvals/capabilityStore'
import type { AgentJournal } from '../diagnostics/agentJournal'
import {
  type ControlMethodContext,
  type ControlServerDeps,
  callControlMethod,
  registerControlMethod,
  registerControlServer,
  stopControlServer,
} from './controlServer'
import { registerExtension, registerPane, removeExtension, removeWindow } from './idRegistry'

const journal = { call: vi.fn() } satisfies Pick<AgentJournal, 'call'>
const seen: string[] = []

registerControlMethod('test.callPane', {
  handler: (params) => {
    seen.push('callPane')
    return { echoed: params }
  },
})
registerControlMethod('test.callExtensionOnly', {
  callers: 'extensions',
  handler: () => {
    seen.push('callExtensionOnly')
    return 'ran'
  },
})
registerControlMethod('test.callManagerOnly', {
  callers: 'manager',
  handler: () => {
    seen.push('callManagerOnly')
    return 'ran'
  },
})
registerControlMethod('test.callNeedsCap', {
  cap: 'all-workspaces',
  handler: () => {
    seen.push('callNeedsCap')
    return 'ran'
  },
})
registerControlMethod('test.callThrows', {
  handler: () => {
    throw new Error('bad-request: nothing')
  },
})

function ctxFor(paneId: string): ControlMethodContext {
  const identity = registerPane({ windowId: '1', workspaceId: 'w1', paneId })
  return {
    identity,
    authed: { externalId: identity.externalId, paneId, workspaceId: 'w1' },
    conn: {
      onClose: () => ({ dispose: () => undefined }),
      onDispose: () => ({ dispose: () => undefined }),
    },
  }
}

afterEach(() => {
  seen.length = 0
  journal.call.mockClear()
  removeWindow('1')
  removeExtension('ext-call')
  stopControlServer()
})

function withJournal(): void {
  registerControlServer(
    {
      journal,
      isSandboxed: () => false,
      execCommand: async () => ({ ok: true, result: null }),
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
    } satisfies ControlServerDeps,
    `${process.env.TMPDIR ?? '/tmp'}/ostia-call-${process.pid}.sock`,
  )
}

describe('callControlMethod', () => {
  it('runs a pane method with the caller’s own context and answers what the handler answered', async () => {
    const ctx = ctxFor('pCall1')
    expect(await callControlMethod('test.callPane', { a: 1 }, ctx)).toEqual({ echoed: { a: 1 } })
    expect(seen).toEqual(['callPane'])
  })

  it('refuses a method nobody registered', async () => {
    await expect(callControlMethod('test.nothing', {}, ctxFor('pCall2'))).rejects.toThrow(
      /unknown-method/,
    )
  })

  it('applies the dispatcher’s caller check: an extension-only or manager-only method never runs for a pane', async () => {
    const ctx = ctxFor('pCall3')
    await expect(callControlMethod('test.callExtensionOnly', {}, ctx)).rejects.toThrow(
      'not-available-to-pane',
    )
    await expect(callControlMethod('test.callManagerOnly', {}, ctx)).rejects.toThrow(
      'not-available-to-pane',
    )
    expect(seen).toEqual([])
  })

  it('refuses an extension identity for a pane method, like the dispatcher', async () => {
    const identity = registerExtension('ext-call')
    const ctx: ControlMethodContext = {
      ...ctxFor('pCall4'),
      identity,
      authed: { externalId: identity.externalId, paneId: '', workspaceId: '' },
    }
    await expect(callControlMethod('test.callPane', {}, ctx)).rejects.toThrow(
      'not-available-to-extension',
    )
  })

  it('checks the method’s capability before the handler and never runs the handler without it', async () => {
    const ctx = ctxFor('pCall5')
    await expect(callControlMethod('test.callNeedsCap', {}, ctx)).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(seen).toEqual([])
    grant(ctx.identity.externalId, 'all-workspaces')
    expect(await callControlMethod('test.callNeedsCap', {}, ctx)).toBe('ran')
    expect(seen).toEqual(['callNeedsCap'])
  })

  it('journals the call and its failure like a socket call', async () => {
    withJournal()
    const ctx = ctxFor('pCall6')
    await callControlMethod('test.callPane', { a: 1 }, ctx)
    await expect(callControlMethod('test.callThrows', {}, ctx)).rejects.toThrow('bad-request')
    expect(journal.call).toHaveBeenCalledTimes(2)
    expect(journal.call.mock.calls[0][0]).toMatchObject({ method: 'test.callPane', caller: 'pane' })
    expect(journal.call.mock.calls[1][0]).toMatchObject({
      method: 'test.callThrows',
      caller: 'pane',
      bytes: 0,
    })
  })
})
