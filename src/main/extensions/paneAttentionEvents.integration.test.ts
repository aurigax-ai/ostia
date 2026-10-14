import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionCaller, ExtensionEventPayloads } from '../../shared/extensions'
import type { CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { getByPaneId, registerPane } from '../control/idRegistry'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { PaneAttentionEvents } from './paneAttentionEvents'

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-host-calls')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

describe('the pane.attention event', () => {
  let dir: string
  let host: ExtensionHost
  let events: PaneAttentionEvents
  const pane = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-agent' })

  const call = async (extId: string, method: string, params?: unknown) => {
    const res = await host.invoke(extId, 'call', { method, params }, caller)
    if (!res.ok) return { rpcError: res.message }
    return res.data as Record<string, unknown>
  }

  const received = async (extId: string) => {
    const res = await host.invoke(extId, 'events', null, caller)
    return (res.ok ? res.data : []) as { type: string; payload: Record<string, unknown> }[]
  }

  const until = async <T>(read: () => Promise<T[]>, count: number): Promise<T[]> => {
    const seen: T[] = []
    for (let i = 0; i < 100 && seen.length < count; i++) {
      seen.push(...(await read()))
      if (seen.length < count) await new Promise((r) => setTimeout(r, 20))
    }
    return seen
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-pane-attention-'))
    const socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => dir,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      readyTimeoutMs: 8000,
      interactiveTimeoutMs: 8000,
      log: () => {},
    })
    events = new PaneAttentionEvents({
      identity: getByPaneId,
      emit: (payload: ExtensionEventPayloads['pane.attention']) =>
        host.emitEvent('pane.attention', payload),
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('GRF-C125 a subscribed extension sees waiting, then working, with the state and no message text', async () => {
    expect(await call('reacher', 'ext.subscribe', { events: ['pane.attention'] })).toMatchObject({
      ok: true,
    })
    events.change(pane.paneId, 'waiting', 'Approve the plan? It holds the secret word.')
    events.change(pane.paneId, 'working', 'still busy')
    const seen = await until(() => received('reacher'), 2)
    expect(seen).toEqual([
      {
        type: 'pane.attention',
        payload: { paneId: pane.externalId, workspaceId: 'w1', state: 'waiting' },
      },
      {
        type: 'pane.attention',
        payload: { paneId: pane.externalId, workspaceId: 'w1', state: 'working' },
      },
    ])
    expect(JSON.stringify(seen)).not.toContain('secret word')
  })

  it('GRF-C126 needs read-board to subscribe, and an unchanged state sends nothing', async () => {
    expect(await call('bare', 'ext.subscribe', { events: ['pane.attention'] })).toMatchObject({
      ok: false,
      error: 'needs-elevation',
    })
    await received('reacher')
    events.change(pane.paneId, 'working', 'a new message, same state')
    events.change(pane.paneId, 'none')
    events.change(pane.paneId, 'none')
    const seen = await until(() => received('reacher'), 2)
    expect(seen.map((e) => e.payload.state)).toEqual(['cleared'])
  })
})
