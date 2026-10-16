import { MANAGER_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { BusEndpoint } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropIdentity, setCaps } from '../approvals/capabilityStore'
import { ExtensionEvents } from './extensionEvents'

const sandboxed = new Set(['sb'])

function runtime(id: string, callers: string[], caps: string[], events: string[]) {
  const sent: unknown[] = []
  const rt = {
    identity: { externalId: id },
    conn: { sendNotification: vi.fn(async (_m: string, p: unknown) => void sent.push(p)) },
    subscriptions: new Set(events),
    callerWorkspaces: new Set(callers),
  }
  return { rt, sent, caps }
}

describe('ExtensionEvents filtering of the new events', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c', 'd']) dropIdentity(id)
  })

  function build(...specs: ReturnType<typeof runtime>[]) {
    for (const spec of specs) setCaps(spec.rt.identity.externalId, spec.caps as never)
    return new ExtensionEvents({
      deps: { sandboxDomains: (ws: string) => (sandboxed.has(ws) ? [] : null) },
      runtimes: new Map(specs.map((spec, i) => [String(i), spec.rt])),
      runs: { settleTerminalWait: () => {} },
    } as never)
  }

  const life = (workspaceId: string) => ({ paneId: 'p', workspaceId, state: 'woken' as const })

  it('sends pane.lifecycle only for workspaces the extension has a caller in, or any unsandboxed one with all-workspaces', () => {
    const own = runtime('a', ['w1'], ['read-board'], ['pane.lifecycle'])
    const all = runtime('b', [], ['read-board', 'all-workspaces'], ['pane.lifecycle'])
    const none = runtime('c', ['w2'], ['read-board'], ['pane.lifecycle'])
    const events = build(own, all, none)
    events.emitEvent('pane.lifecycle', life('w1'))
    events.emitEvent('pane.lifecycle', life('sb'))
    expect(own.sent).toHaveLength(1)
    expect(all.sent).toHaveLength(1)
    expect(none.sent).toHaveLength(0)
  })

  it('never sends a sandboxed workspace to an extension that only holds all-workspaces', () => {
    const all = runtime('b', [], ['read-board', 'all-workspaces'], ['pane.lifecycle'])
    build(all).emitEvent('pane.lifecycle', life('sb'))
    expect(all.sent).toHaveLength(0)
  })

  const bus = (from: BusEndpoint, to: BusEndpoint) => ({
    id: 'm',
    from,
    to,
    kind: 'message' as const,
    phase: 'queued' as const,
  })

  it('skips a runtime without read-bus', () => {
    const no = runtime('a', ['w1'], ['read-board'], ['bus.message'])
    build(no).emitEvent(
      'bus.message',
      bus({ id: 'x', workspaceId: 'w1' }, { id: 'y', workspaceId: 'w1' }),
    )
    expect(no.sent).toHaveLength(0)
  })

  it('anonymises the side in a workspace the extension cannot see, and drops a message with no visible side', () => {
    const rt = runtime('a', ['w1'], ['read-board', 'read-bus'], ['bus.message'])
    const events = build(rt)
    events.emitEvent(
      'bus.message',
      bus({ id: 'x', workspaceId: 'w1' }, { id: 'secret', workspaceId: 'w2' }),
    )
    events.emitEvent(
      'bus.message',
      bus({ id: 'q', workspaceId: 'w2' }, { id: 'r', workspaceId: 'sb' }),
    )
    events.emitEvent('bus.message', bus({ id: 'ostia' }, { id: 'x', workspaceId: 'w1' }))
    expect(rt.sent.map((m) => (m as { payload: unknown }).payload)).toEqual([
      expect.objectContaining({ from: { id: 'x', workspaceId: 'w1' }, to: { id: '' } }),
      expect.objectContaining({ from: { id: 'ostia' }, to: { id: 'x', workspaceId: 'w1' } }),
    ])
    expect(JSON.stringify(rt.sent)).not.toContain('secret')
  })

  it('refuses to subscribe to bus.message without read-bus and accepts it with', () => {
    const rt = runtime('a', [], ['read-board'], [])
    const events = build(rt)
    const host = (events as unknown as { host: { runtimeOf: () => unknown } }).host
    host.runtimeOf = () => rt.rt
    const subscribe = () =>
      events.subscribe({ externalId: 'a' } as never, {} as never, { events: ['bus.message'] })
    expect(subscribe()).toMatchObject({ ok: false, error: 'needs-elevation' })
    setCaps('a', ['read-board', 'read-bus'])
    expect(subscribe()).toMatchObject({ ok: true })
  })

  it('keeps read-bus out of the manager capabilities', () => {
    expect(MANAGER_CAPABILITIES).not.toContain('read-bus')
  })
})
