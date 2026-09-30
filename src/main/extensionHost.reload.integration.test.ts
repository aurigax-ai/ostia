import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ExtensionCaller } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'

const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }
const jsonrpc = require.resolve('vscode-jsonrpc/node')

const MAIN_JS = `
const { createConnection } = require('node:net')
const rpc = require(${JSON.stringify(jsonrpc)})
const socket = createConnection(process.env.PINE_SOCKET)
const conn = rpc.createMessageConnection(
  new rpc.StreamMessageReader(socket),
  new rpc.StreamMessageWriter(socket),
)
conn.onRequest('ext.command', () => ({ ok: true, data: { pid: process.pid } }))
socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.PINE_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['ping'] })
})
`

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ExtensionHost hot reload of the user extensions directory', () => {
  let dir: string
  let userRoot: string
  let host: ExtensionHost
  let socketPath: string
  let store: ExtensionStore

  const writeExtension = (id: string, manifest: Record<string, unknown>): string => {
    const extDir = join(userRoot, id)
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'main.js'), MAIN_JS)
    writeFileSync(
      join(extDir, 'pine.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', main: 'main.js', ...manifest }),
    )
    return extDir
  }
  const pinger = (capabilities: string[], version = '1.0.0') =>
    writeExtension('pinger', {
      version,
      capabilities,
      contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
    })
  const info = (id: string) => host.list().find((e) => e.id === id)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-ext-reload-'))
    socketPath = join(dir, 'control.sock')
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
  })

  afterEach(() => {
    host.stopAll()
    rmSync(userRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const startHost = (): void => {
    userRoot = mkdtempSync(join(dir, 'user-'))
    store = new ExtensionStore(join(userRoot, '..', `${Date.now()}-extensions.json`))
    host = new ExtensionHost({
      roots: [{ dir: userRoot, builtin: false }],
      store,
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      restartDelayMs: 20,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
  }

  it('lists an added extension as waiting for approval and never starts it on its own', async () => {
    startHost()
    expect(host.list()).toEqual([])
    pinger(['notify'])
    host.rescan()
    expect(info('pinger')).toMatchObject({ status: 'pending-approval', enabled: false })
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({
      ok: false,
      error: 'extension-disabled',
    })
    host.approve('pinger')
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({ ok: true })
  })

  it('reloads a changed manifest, restarts the process and keeps new capabilities unapproved', async () => {
    startHost()
    pinger(['notify'])
    host.rescan()
    host.approve('pinger')
    const first = await host.invoke('pinger', 'ping', null, caller)
    const firstPid = first.ok ? (first.data as { pid: number }).pid : 0
    pinger(['notify', 'shell'], '2.0.0')
    host.rescan()
    expect(info('pinger')).toMatchObject({
      version: '2.0.0',
      granted: ['notify'],
      unapproved: ['shell'],
    })
    const second = await host.invoke('pinger', 'ping', null, caller)
    expect(second.ok).toBe(true)
    expect(second.ok && (second.data as { pid: number }).pid).not.toBe(firstPid)
  })

  it('drops a removed extension and stops its process', async () => {
    startHost()
    const extDir = pinger(['notify'])
    host.rescan()
    host.approve('pinger')
    expect((await host.invoke('pinger', 'ping', null, caller)).ok).toBe(true)
    rmSync(extDir, { recursive: true, force: true })
    host.rescan()
    expect(info('pinger')).toBeUndefined()
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
  })

  it('rescans by itself when the directory changes on disk', async () => {
    startHost()
    host.watchUserExtensions()
    pinger(['notify'])
    await until(() => info('pinger'))
    expect(info('pinger')?.status).toBe('pending-approval')
    pinger(['notify'], '3.0.0')
    await until(() => (info('pinger')?.version === '3.0.0' ? true : undefined))
  })

  it('resolves a file panel path inside the extension and refuses one outside it', async () => {
    startHost()
    const extDir = join(userRoot, 'static')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'panel.html'), '<p>home</p>')
    writeFileSync(join(extDir, 'card.html'), '<p>card</p>')
    writeFileSync(
      join(extDir, 'pine.json'),
      JSON.stringify({
        id: 'static',
        name: 'Static',
        version: '1',
        contributes: { panel: { title: 'S', entry: 'panel.html' } },
      }),
    )
    host.rescan()
    host.approve('static')
    const context = { workspaceId: 's1', locale: 'en' }
    expect(await host.resolvePanel('static', context)).toEqual({
      ok: true,
      src: pathToFileURL(join(extDir, 'panel.html')).href,
    })
    expect(await host.resolvePanel('static', { ...context, path: '/card.html?id=4#top' })).toEqual({
      ok: true,
      src: `${pathToFileURL(join(extDir, 'card.html')).href}?id=4#top`,
    })
    for (const path of ['/../other/x.html', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect(await host.resolvePanel('static', { ...context, path })).toEqual({
        ok: false,
        error: 'panel-url-not-allowed',
      })
    }
  })
})
