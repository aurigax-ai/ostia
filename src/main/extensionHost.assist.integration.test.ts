import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CancellationTokenSource } from 'vscode-jsonrpc/node'
import type { AssistAvailability, AssistOpenUiRequest } from '../shared/assist'
import type { ExtensionCaller } from '../shared/extensions'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { createSecretStore } from './extensionSecrets'
import { ExtensionStore } from './extensionStore'

const fixtures = resolve(__dirname, '../../test/fixtures/extensions-assist')

const caller: ExtensionCaller = { kind: 'user', capabilities: [] }

async function until<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('assist contribution points over a real control socket', () => {
  let dir: string
  let host: ExtensionHost
  let store: ExtensionStore
  let saved: unknown = {}
  const broadcasts: { channel: string; payload: unknown }[] = []
  const openedUi: AssistOpenUiRequest[] = []
  const lastAvailability = (): AssistAvailability =>
    (broadcasts.filter((b) => b.channel === 'assist:availability').at(-1)?.payload ??
      {}) as AssistAvailability

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-ext-assist-'))
    const socketPath = join(dir, 'control.sock')
    store = new ExtensionStore(join(dir, 'extensions.json'))
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: false }],
      store,
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn: () => {},
      openAssistUiIn: (req) => openedUi.push(req),
      notify: () => {},
      secrets: createSecretStore({
        load: () => saved,
        save: (data) => {
          saved = data
        },
        canEncrypt: () => true,
        encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
        decrypt: (secret) => Buffer.from(secret, 'base64').toString().slice(4),
      }),
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }),
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('offers nothing while the extension waits for approval', async () => {
    expect(host.list().find((e) => e.id === 'oracle')?.status).toBe('pending-approval')
    expect(host.assistAvailability()).toEqual({})
    expect(await host.assist('chat', { messages: [{ role: 'user', content: 'hi' }] })).toEqual({
      ok: false,
      error: 'unavailable',
    })
  })

  it('starts with the window once approved and lists only ready, contributed points', async () => {
    host.approve('oracle')
    const availability = await until(() =>
      lastAvailability().chat ? lastAvailability() : undefined,
    )
    expect(availability).toEqual({
      chat: { extId: 'oracle', name: 'Oracle', label: 'fake · big', ref: { extId: 'oracle' } },
      command: {
        extId: 'oracle',
        name: 'Oracle',
        label: 'fake · small',
        ref: { extId: 'oracle' },
      },
      terminal: {
        extId: 'oracle',
        name: 'Oracle',
        label: 'fake · small',
        ref: { extId: 'oracle' },
      },
    })
    expect(host.assistCatalog()).toEqual({
      models: [
        {
          ref: { extId: 'oracle' },
          group: 'Oracle',
          label: 'fake',
          points: ['command', 'terminal', 'chat'],
        },
      ],
      chat: { extId: 'oracle' },
      fast: { extId: 'oracle' },
    })
    expect(host.list().find((e) => e.id === 'oracle')?.assist).toEqual([
      'chat',
      'command',
      'input',
      'terminal',
    ])
  })

  it('streams chat chunks in order and returns the normalized full reply', async () => {
    const chunks: string[] = []
    const res = await host.assist(
      'chat',
      {
        messages: [{ role: 'user', content: 'list files' }],
        context: [
          { kind: 'cwd', label: 'Folder', text: '/tmp' },
          { kind: 'bogus', label: 'x', text: 'y' },
        ],
      },
      { onChunk: (text) => chunks.push(text) },
    )
    expect(chunks).toEqual(['Use ', '`ls -la`', ' (1 context)'])
    expect(res).toEqual({ ok: true, result: { text: 'Use `ls -la` (1 context)' } })
  })

  it('rejects a malformed request before it reaches the extension', async () => {
    expect(await host.assist('chat', { messages: [] })).toEqual({ ok: false, error: 'invalid' })
    expect(await host.assist('command', { query: '   ' })).toEqual({ ok: false, error: 'invalid' })
  })

  it('cancels an in-flight request and tells the extension', async () => {
    const source = new CancellationTokenSource()
    const pending = host.assist(
      'chat',
      { messages: [{ role: 'user', content: 'hang' }] },
      { token: source.token },
    )
    setTimeout(() => source.cancel(), 50)
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
  })

  it('dedupes and drops empty command suggestions and passes typed errors through', async () => {
    expect(await host.assist('command', { query: 'list files' })).toEqual({
      ok: true,
      result: { suggestions: [{ command: 'ls -la', description: 'list' }] },
    })
    expect(await host.assist('command', { query: 'rate' })).toEqual({
      ok: false,
      error: 'rate-limited',
      message: 'slow down',
    })
  })

  it('refuses a point the extension did not report ready', async () => {
    expect(await host.assist('input', { text: 'fix teh typo', tasks: ['typos'] })).toEqual({
      ok: false,
      error: 'unavailable',
    })
  })

  it('stores a secret encrypted, hands it only to its extension, and never lists the value', async () => {
    expect(await host.invoke('oracle', 'secret', null, caller)).toMatchObject({
      ok: true,
      data: { ok: true, value: null },
    })
    const before = (await host.invoke('oracle', 'events', null, caller)) as { data: number }
    const res = host.setSecret('oracle', 'apiKey', 'sk-test-123')
    expect(res.ok).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('sk-test-123')
    const info = host.list().find((e) => e.id === 'oracle')
    expect(info?.secretsSet).toEqual(['apiKey'])
    expect(JSON.stringify(host.list())).not.toContain('sk-test-123')
    expect(await host.invoke('oracle', 'secret', null, caller)).toMatchObject({
      data: { ok: true, value: 'sk-test-123' },
    })
    await expect
      .poll(
        async () =>
          ((await host.invoke('oracle', 'events', null, caller)) as { data: number }).data,
      )
      .toBeGreaterThan(before.data)
  })

  it('refuses an undeclared secret key', () => {
    expect(host.setSecret('oracle', 'other', 'x')).toEqual({ ok: false, error: 'unknown-secret' })
    expect(host.setSecret('oracle', 'apiKey', 42)).toEqual({ ok: false, error: 'invalid-value' })
  })

  it('clears a secret', async () => {
    expect(host.setSecret('oracle', 'apiKey', null).ok).toBe(true)
    expect(host.list().find((e) => e.id === 'oracle')?.secretsSet).toEqual([])
    expect(await host.invoke('oracle', 'secret', null, caller)).toMatchObject({
      data: { ok: true, value: null },
    })
  })

  it('reports only known features bound to boolean settings, with on read from the setting', () => {
    expect(host.assistOverview()).toEqual([
      {
        extId: 'oracle',
        name: 'Oracle',
        label: 'fake',
        setup: null,
        lastError: 'model busy',
        features: [{ id: 'chat', setting: 'chat', ready: true, on: true }],
        models: true,
        providers: [],
        kinds: [],
        keysSet: [],
      },
    ])
    host.setSetting('oracle', 'chat', false)
    expect(host.assistOverview()[0].features[0].on).toBe(false)
    host.setSetting('oracle', 'chat', null)
  })

  it('lists the models an extension reports, normalized, and loads and unloads one', async () => {
    const list = await host.assistModels('oracle')
    expect(list).toMatchObject({ ok: true, lifecycle: true })
    if (!list.ok) throw new Error('no list')
    expect(list.models.map((m) => m.id)).toEqual(['small', 'big'])
    expect(list.models[0]).toEqual({ id: 'small', name: 'Small', loaded: false, idleSecs: 12 })
    expect(list.models[1].installed).toBe(false)
    expect(list.models[1].loaded).toBeUndefined()
    expect(list.models[1].description?.length).toBe(400)
    expect(await host.setAssistModelLoaded('oracle', 'small', true)).toEqual({ ok: true })
    const after = await host.assistModels('oracle')
    expect(after.ok && after.models[0].loaded).toBe(true)
    expect(await host.setAssistModelLoaded('oracle', 'broken', true)).toEqual({
      ok: false,
      error: 'runtime refused',
    })
    expect(await host.setAssistModelLoaded('oracle', '', true)).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await host.assistModels('nobody')).toEqual({ ok: false, error: 'unavailable' })
  })

  it('keeps a terminal completion to one line', async () => {
    expect(
      await host.assist('terminal', { line: 'ls', history: [{ command: 'pwd', exitCode: 0 }] }),
    ).toEqual({ ok: true, result: { text: ' -la  # ls' } })
    expect(await host.assist('terminal', { line: '  ' })).toEqual({ ok: false, error: 'invalid' })
  })

  it('answers shortcuts the renderer reported and null for unbound commands', async () => {
    host.setShortcuts({ 'assist.compose': 'Ctrl+Shift+J', bad: 5 })
    expect(
      await host.invoke('oracle', 'shortcuts', ['assist.compose', 'assist.chat'], caller),
    ).toMatchObject({
      data: { ok: true, shortcuts: { 'assist.compose': 'Ctrl+Shift+J', 'assist.chat': null } },
    })
  })

  it('opens core assist UI only for points the extension contributes', async () => {
    expect(
      await host.invoke('oracle', 'openui', { ui: 'chat', workspaceId: 'w1' }, caller),
    ).toEqual({ ok: true })
    expect(openedUi).toEqual([{ extId: 'oracle', ui: 'chat', workspaceId: 'w1' }])
    expect(await host.invoke('oracle', 'openui', { ui: 'shell' }, caller)).toMatchObject({
      ok: false,
      error: 'invalid-params',
    })
  })

  it('drops the points of a disabled extension', async () => {
    host.setEnabled('oracle', false)
    expect(host.assistAvailability()).toEqual({})
    expect(lastAvailability()).toEqual({})
    expect(host.assistOverview()).toEqual([])
    expect(await host.assistModels('oracle')).toEqual({ ok: false, error: 'unavailable' })
  })
})
