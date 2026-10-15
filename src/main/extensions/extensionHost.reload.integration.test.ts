import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtensionCaller, PaneChip } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/types'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { registerPane } from '../control/idRegistry'
import { ExtensionHost } from './extensionHost'
import { registerExtensionMethods } from './extensionMethods'
import { ExtensionStore } from './extensionStore'

const POLL = { timeout: 5000, interval: 20 }

const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }
const jsonrpc = require.resolve('vscode-jsonrpc/node')

const mainJs = (commands: string[]): string => `
const { createConnection } = require('node:net')
const rpc = require(${JSON.stringify(jsonrpc)})
const socket = createConnection(process.env.OSTIA_SOCKET)
const conn = rpc.createMessageConnection(
  new rpc.StreamMessageReader(socket),
  new rpc.StreamMessageWriter(socket),
)
conn.onRequest('ext.command', ({ command, args }) =>
  command === 'chip'
    ? conn.sendRequest('ext.setPaneChip', args)
    : { ok: true, data: { pid: process.pid } },
)
socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ${JSON.stringify(commands)} })
})
`

function settleWatchers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, process.platform === 'darwin' ? 600 : 0))
}

describe('ExtensionHost hot reload of the user extensions directory', () => {
  let dir: string
  let userRoot: string
  let host: ExtensionHost
  let socketPath: string
  let store: ExtensionStore
  let chipBroadcasts: PaneChip[][] = []
  const pane = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p1' })

  const writeExtension = (
    id: string,
    manifest: Record<string, unknown>,
    commands = ['ping'],
  ): string => {
    const extDir = join(userRoot, id)
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'main.js'), mainJs(commands))
    writeFileSync(
      join(extDir, 'ostia.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', api: '4.0', main: 'main.js', ...manifest }),
    )
    return extDir
  }
  const pinger = (capabilities: string[], version = '1.0.0') =>
    writeExtension('pinger', {
      version,
      api: '4.0',
      capabilities,
      contributes: { commands: [{ id: 'ping', title: 'Ping' }] },
    })
  const info = (id: string) => host.list().find((e) => e.id === id)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-reload-'))
    socketPath = join(dir, 'control.sock')
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

  afterEach(() => {
    host.processes.stopAll()
    rmSync(userRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const startHost = (): void => {
    userRoot = mkdtempSync(join(dir, 'user-'))
    chipBroadcasts = []
    store = new ExtensionStore(join(userRoot, '..', `${Date.now()}-extensions.json`))
    host = new ExtensionHost({
      roots: [{ dir: userRoot, builtin: false }],
      store,
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: (channel, payload) => {
        if (channel === 'extensions:chips') chipBroadcasts.push(payload as PaneChip[])
      },
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
    host.processes.rescan()
    expect(info('pinger')).toMatchObject({ status: 'pending-approval', enabled: false })
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({
      ok: false,
      error: 'extension-disabled',
    })
    host.processes.approve('pinger')
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({ ok: true })
  })

  it('reloads a changed manifest, restarts the process and keeps new capabilities unapproved', async () => {
    startHost()
    pinger(['notify'])
    host.processes.rescan()
    host.processes.approve('pinger')
    const first = await host.invoke('pinger', 'ping', null, caller)
    const firstPid = first.ok ? (first.data as { pid: number }).pid : 0
    pinger(['notify', 'shell'], '2.0.0')
    host.processes.rescan()
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
    host.processes.rescan()
    host.processes.approve('pinger')
    expect((await host.invoke('pinger', 'ping', null, caller)).ok).toBe(true)
    rmSync(extDir, { recursive: true, force: true })
    host.processes.rescan()
    expect(info('pinger')).toBeUndefined()
    expect(await host.invoke('pinger', 'ping', null, caller)).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
  })

  it('an extension whose manifest turns invalid while ostia runs is dropped with its pane chips', async () => {
    startHost()
    const extDir = writeExtension(
      'chipper',
      {
        capabilities: [],
        contributes: {
          commands: [{ id: 'chip', title: 'Chip' }],
          paneChips: [{ id: 'status', title: 'Status' }],
        },
      },
      ['chip'],
    )
    host.processes.rescan()
    host.processes.approve('chipper')
    const chip = { paneId: pane.externalId, id: 'status', text: 'hello chip' }
    expect(await host.invoke('chipper', 'chip', chip, caller)).toEqual({ ok: true })
    expect(host.slots.paneChips()).toMatchObject([
      { extId: 'chipper', paneId: 'p1', text: 'hello chip' },
    ])

    writeFileSync(join(extDir, 'ostia.json'), '{ "broken": ')
    host.processes.rescan()
    expect(info('chipper')).toBeUndefined()
    expect(host.slots.paneChips()).toEqual([])
    expect(chipBroadcasts.at(-1)).toEqual([])
    expect(await host.invoke('chipper', 'chip', chip, caller)).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
  })

  it('rescans by itself when the directory changes on disk', async () => {
    startHost()
    host.processes.watchUserExtensions()
    await settleWatchers()
    pinger(['notify'])
    await vi.waitUntil(() => info('pinger'), POLL)
    expect(info('pinger')?.status).toBe('pending-approval')
    await settleWatchers()
    pinger(['notify'], '3.0.0')
    await vi.waitUntil(() => info('pinger')?.version === '3.0.0', POLL)
  })

  it('picks up a manifest written into a directory that appeared empty earlier', async () => {
    startHost()
    host.processes.watchUserExtensions()
    await settleWatchers()
    mkdirSync(join(userRoot, 'late'))
    await new Promise((r) => setTimeout(r, 600))
    expect(info('late')).toBeUndefined()
    writeExtension('late', { capabilities: [] })
    await vi.waitUntil(() => info('late'), POLL)
    expect(info('late')?.status).toBe('pending-approval')
  })

  it('resolves a file panel path inside the extension and refuses one outside it', async () => {
    startHost()
    const extDir = join(userRoot, 'static')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, 'panel.html'), '<p>home</p>')
    writeFileSync(join(extDir, 'card.html'), '<p>card</p>')
    writeFileSync(
      join(extDir, 'ostia.json'),
      JSON.stringify({
        id: 'static',
        name: 'Static',
        version: '1',
        api: '4.0',
        contributes: { panel: { title: 'S', entry: 'panel.html' } },
      }),
    )
    host.processes.rescan()
    host.processes.approve('static')
    const context = { workspaceId: 's1', locale: 'en' }
    expect(await host.panels.resolvePanel('static', context)).toEqual({
      ok: true,
      src: pathToFileURL(join(extDir, 'panel.html')).href,
    })
    expect(
      await host.panels.resolvePanel('static', { ...context, path: '/card.html?id=4#top' }),
    ).toEqual({
      ok: true,
      src: `${pathToFileURL(join(extDir, 'card.html')).href}?id=4#top`,
    })
    for (const path of ['/../other/x.html', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect(await host.panels.resolvePanel('static', { ...context, path })).toEqual({
        ok: false,
        error: 'panel-url-not-allowed',
      })
    }
  })
})
