import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller, ExtensionInfo } from '../shared/extensions'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import {
  type ExtensionConfirmRequest,
  ExtensionHost,
  registerExtensionMethods,
} from './extensionHost'
import { ExtensionStore } from './extensionStore'

const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }
const jsonrpc = require.resolve('vscode-jsonrpc/node')

const MAIN_JS = `
const { createConnection } = require('node:net')
const rpc = require(${JSON.stringify(jsonrpc)})
const socket = createConnection(process.env.OSTIA_SOCKET)
const conn = rpc.createMessageConnection(
  new rpc.StreamMessageReader(socket),
  new rpc.StreamMessageWriter(socket),
)
let announced = null
conn.onNotification('ext.event', ({ type, payload }) => {
  if (type === 'locale.changed') announced = payload.locale
})
conn.onRequest('ext.command', async ({ command }) => {
  if (command === 'locale') return { ok: true, data: await conn.sendRequest('ext.locale') }
  if (command === 'announced') return { ok: true, data: { announced } }
  if (command === 'confirm') {
    return { ok: true, data: await conn.sendRequest('ext.confirm', { title: 'T', message: 'M' }) }
  }
  return { ok: false, error: 'unknown' }
})
socket.on('close', () => process.exit(0))
conn.listen()
socket.on('connect', async () => {
  await conn.sendRequest('hello', { token: process.env.OSTIA_TOKEN })
  await conn.sendRequest('ext.registerCommands', { commands: ['locale', 'announced', 'confirm'] })
})
`

const MANIFEST = {
  id: 'greeter',
  name: 'Greeter',
  version: '1.0.0',
  api: '2.0',
  description: 'Says hello',
  main: 'main.js',
  locales: ['zh-Hant'],
  contributes: {
    commands: [
      { id: 'locale', title: 'Report Locale', category: 'Greeter' },
      { id: 'announced', title: 'Last Announced Locale', palette: false },
      { id: 'confirm', title: 'Ask', palette: false },
    ],
    settings: { word: { type: 'string', default: 'hi', title: 'Word', description: 'The word' } },
  },
}

const ZH_HANT = {
  manifest: {
    name: '問候者',
    'commands.locale.title': '回報語言',
    'commands.locale.category': '問候者',
    'settings.word.title': '字詞',
  },
}

async function until(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ExtensionHost resolves manifest strings for the language', () => {
  let dir: string
  let root: string
  let host: ExtensionHost
  let socketPath: string
  let locale: string | undefined
  const broadcast = vi.fn()
  const confirm = vi.fn(async (_req: ExtensionConfirmRequest) => true)
  const logged: string[] = []

  const extDir = (): string => join(root, 'greeter')
  const writeCatalog = (catalog: unknown): void => {
    mkdirSync(join(extDir(), 'locales'), { recursive: true })
    writeFileSync(join(extDir(), 'locales', 'zh-Hant.json'), JSON.stringify(catalog))
  }
  const greeter = (): ExtensionInfo => {
    const info = host.list().find((e) => e.id === 'greeter')
    if (!info) throw new Error('greeter is not listed')
    return info
  }
  const changedLists = (): ExtensionInfo[][] =>
    broadcast.mock.calls.filter(([channel]) => channel === 'extensions:changed').map(([, l]) => l)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-locales-host-'))
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
    rmSync(root, { recursive: true, force: true })
    broadcast.mockClear()
    confirm.mockClear()
    logged.length = 0
  })

  afterAll(() => {
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  const startHost = (opts: { builtin: boolean; catalog?: unknown }): void => {
    root = mkdtempSync(join(dir, 'root-'))
    mkdirSync(extDir())
    writeFileSync(join(extDir(), 'main.js'), MAIN_JS)
    writeFileSync(join(extDir(), 'ostia.json'), JSON.stringify(MANIFEST))
    if (opts.catalog !== undefined) writeCatalog(opts.catalog)
    host = new ExtensionHost({
      roots: [{ dir: root, builtin: opts.builtin }],
      store: new ExtensionStore(join(dir, `${Date.now()}-${Math.random()}-extensions.json`)),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      locale: () => locale,
      broadcast,
      confirm,
      openPanelIn: () => {},
      notify: () => {},
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: (_id, line) => logged.push(line),
    })
  }

  it('lists the manifest in English until the language has a catalog', () => {
    locale = 'en'
    startHost({ builtin: true, catalog: ZH_HANT })
    expect(greeter()).toMatchObject({ name: 'Greeter', description: 'Says hello' })
    expect(greeter().commands[0]).toMatchObject({ title: 'Report Locale', category: 'Greeter' })
    locale = 'fr'
    expect(greeter().name).toBe('Greeter')
  })

  it('lists translated strings with English for the ones the catalog leaves out', () => {
    locale = 'zh-Hant'
    startHost({ builtin: true, catalog: ZH_HANT })
    expect(greeter()).toMatchObject({ name: '問候者', description: 'Says hello' })
    expect(greeter().commands.map((c) => c.title)).toEqual([
      '回報語言',
      'Last Announced Locale',
      'Ask',
    ])
    expect(greeter().commands[0].category).toBe('問候者')
    expect(greeter().settings[0]).toMatchObject({ title: '字詞', description: 'The word' })
  })

  it('translates an extension that still waits for approval, so the human reads what they approve', () => {
    locale = 'zh-Hant'
    startHost({ builtin: false, catalog: ZH_HANT })
    expect(greeter()).toMatchObject({ status: 'pending-approval', name: '問候者' })
  })

  it('keeps English for agents whatever the language', () => {
    locale = 'zh-Hant'
    startHost({ builtin: true, catalog: ZH_HANT })
    const listed = host.listForAgents().find((e) => e.id === 'greeter')
    expect(listed?.name).toBe('Greeter')
    expect(listed?.commands[0].title).toBe('Report Locale')
  })

  it('broadcasts the list again when the language changes, and only then', () => {
    locale = 'en'
    startHost({ builtin: true, catalog: ZH_HANT })
    host.refreshLocale()
    expect(changedLists()).toEqual([])
    locale = 'zh-Hant'
    host.refreshLocale()
    expect(changedLists()).toHaveLength(1)
    expect(changedLists()[0].find((e) => e.id === 'greeter')?.name).toBe('問候者')
    host.refreshLocale()
    expect(changedLists()).toHaveLength(1)
    locale = 'en'
    host.refreshLocale()
    expect(changedLists()[1].find((e) => e.id === 'greeter')?.name).toBe('Greeter')
  })

  it('logs a bad catalog entry, drops it and keeps the rest', () => {
    locale = 'zh-Hant'
    startHost({
      builtin: true,
      catalog: { manifest: { name: '問候者', 'commands.wipe.title': '清除' } },
    })
    expect(greeter().name).toBe('問候者')
    expect(greeter().commands.map((c) => c.id)).toEqual(['locale', 'announced', 'confirm'])
    expect(logged).toEqual([
      "locales/zh-Hant.json: manifest.commands.wipe.title: not a string this extension's manifest declares",
    ])
  })

  it('picks up a catalog written after discovery on the next rescan', () => {
    locale = 'zh-Hant'
    startHost({ builtin: true })
    expect(greeter().name).toBe('Greeter')
    writeCatalog(ZH_HANT)
    host.rescan()
    expect(greeter().name).toBe('問候者')
    expect(
      changedLists()
        .at(-1)
        ?.find((e) => e.id === 'greeter')?.name,
    ).toBe('問候者')
  })

  it('tells a running extension the language on request and when it changes', async () => {
    locale = 'zh-Hant'
    startHost({ builtin: true, catalog: ZH_HANT })
    expect(await host.invoke('greeter', 'locale', null, caller)).toMatchObject({
      ok: true,
      data: { ok: true, locale: 'zh-Hant' },
    })
    expect(await host.invoke('greeter', 'announced', null, caller)).toMatchObject({
      data: { announced: null },
    })
    locale = 'en'
    host.refreshLocale()
    await until(async () => {
      const res = await host.invoke('greeter', 'announced', null, caller)
      return res.ok && (res.data as { announced: unknown }).announced === 'en'
    })
    locale = undefined
    expect(await host.invoke('greeter', 'locale', null, caller)).toMatchObject({
      data: { locale: 'en' },
    })
  })

  it('names the extension in its confirm dialog in the language', async () => {
    locale = 'zh-Hant'
    startHost({ builtin: true, catalog: ZH_HANT })
    await host.invoke('greeter', 'confirm', null, caller)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ extName: '問候者' }))
  })
})
