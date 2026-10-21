import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionConnections } from './extensionConnections'
import { ExtensionHost } from './extensionHost'
import { registerExtensionMethods } from './extensionMethods'
import { createSecretStore, type SecretStoreDeps } from './extensionSecrets'
import { ExtensionStore } from './extensionStore'

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-connections')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }
const TOKEN = ['tok', 'z'.repeat(18)].join('-')

describe('an extension reads its own connections, by name, from main', () => {
  let dir: string
  let host: ExtensionHost

  const call = async (extId: string, method: string, params?: unknown) => {
    const res = await host.invoke(extId, 'call', { method, params }, caller)
    return res.ok ? res.data : res
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-connections-'))
    const socketPath = join(dir, 'control.sock')
    let data: unknown = {}
    const deps: SecretStoreDeps = {
      load: () => data,
      save: (next) => {
        data = JSON.parse(JSON.stringify(next))
      },
      canEncrypt: () => true,
      encrypt: (plain) => Buffer.from(`x${plain}`).toString('base64'),
      decrypt: (secret) => Buffer.from(secret, 'base64').toString().slice(1),
    }
    const secrets = createSecretStore(deps)
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      secrets,
      connections: new ExtensionConnections(join(dir, 'extension-connections.json'), () => secrets),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (sid) => (sid ? `/w/${sid}` : undefined),
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
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
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists the kinds for Settings and keeps the secret out of the list', () => {
    const info = host.list().find((e) => e.id === 'linked')
    expect(info?.connectionKinds.map((k) => k.kind)).toEqual(['http'])
    expect(
      host.config.saveConnection('linked', {
        name: 'api',
        kind: 'http',
        fields: { baseUrl: 'https://api.example.test' },
        secrets: { secret: TOKEN },
      }),
    ).toEqual({ ok: true })
    expect(host.config.connectionsOf('linked')).toEqual([
      {
        name: 'api',
        kind: 'http',
        fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
        secretsSet: ['secret'],
      },
    ])
    expect(JSON.stringify(host.list())).not.toContain(TOKEN)
    expect(host.list().find((e) => e.id === 'linked')?.secretsSet).toEqual([])
  })

  it('gives the owning extension its connection with the secret, and another extension nothing', async () => {
    expect(await call('linked', 'ext.connections')).toEqual({
      ok: true,
      connections: [{ name: 'api', kind: 'http' }],
    })
    expect(await call('linked', 'ext.connection', { name: 'api' })).toEqual({
      ok: true,
      connection: {
        name: 'api',
        kind: 'http',
        fields: { baseUrl: 'https://api.example.test', auth: 'bearer' },
        secrets: { secret: TOKEN },
      },
    })
    expect(await call('other', 'ext.connections')).toEqual({ ok: true, connections: [] })
    expect(await call('other', 'ext.connection', { name: 'api' })).toEqual({
      ok: true,
      connection: null,
    })
    expect(await call('linked', 'ext.getSecret', { key: '@connection/api/secret' })).toMatchObject({
      ok: false,
      error: 'not-contributed',
    })
  })

  it('tells the extension when the human changed its connections', async () => {
    expect(host.config.removeConnection('linked', 'api')).toEqual({ ok: true })
    await vi.waitUntil(
      async () => {
        const res = await host.invoke('linked', 'events', null, caller)
        return res.ok && Array.isArray(res.data) && res.data.includes('connections.changed')
      },
      { timeout: 8000, interval: 20 },
    )
    expect(await call('linked', 'ext.connection', { name: 'api' })).toEqual({
      ok: true,
      connection: null,
    })
    expect(
      host.config.saveConnection('nope', { name: 'x', kind: 'http', fields: {} }),
    ).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
  })
})
