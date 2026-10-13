import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  AssistCatalog,
  AssistModelSettings,
  AssistProviderConfig,
  AssistProviderEntry,
} from '../../shared/assist'
import type { ExtensionCaller } from '../../shared/extensions'
import { registerControlServer, stopControlServer } from '../control/controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { createSecretStore } from './extensionSecrets'
import { ExtensionStore } from './extensionStore'

const plainFixtures = resolve(__dirname, '../../../test/fixtures/extensions-assist')
const modelFixtures = resolve(__dirname, '../../../test/fixtures/extensions-assist-models')

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

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function provider(patch: Partial<AssistProviderConfig> & { id: string }): AssistProviderConfig {
  return {
    extId: 'switchboard',
    kind: 'plain',
    name: patch.id,
    baseUrl: '',
    enabled: true,
    models: [],
    ...patch,
  }
}

const chat = (text: string) => ({ messages: [{ role: 'user', content: text }] })

describe('assist routing across providers, models and extensions', () => {
  let dir: string
  let host: ExtensionHost
  let settings: Partial<AssistModelSettings> = {}
  let storedKeys: unknown = {}
  let unreadable = false
  const broadcasts: { channel: string; payload: unknown }[] = []
  const lastCatalog = (): AssistCatalog | undefined =>
    broadcasts.filter((b) => b.channel === 'assist:catalog').at(-1)?.payload as
      | AssistCatalog
      | undefined
  const given = async (): Promise<{ entries: AssistProviderEntry[]; events: number }> => {
    const res = (await host.invoke('switchboard', 'entries', null, caller)) as {
      data: { entries: AssistProviderEntry[]; events: number }
    }
    return res.data
  }
  const labels = (catalog: AssistCatalog): string[] =>
    catalog.models.map((m) => `${m.group}/${m.label}`)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-models-'))
    const socketPath = join(dir, 'control.sock')
    settings = {
      providers: [
        provider({ id: 'local', name: 'Local', models: ['small', 'big'] }),
        provider({ id: 'hosted', name: 'Hosted', kind: 'keyed', models: ['large'] }),
        provider({ id: 'parked', enabled: false, models: ['idle'] }),
        provider({ id: 'foreign', extId: 'oracle', models: ['x'] }),
      ],
    }
    host = new ExtensionHost({
      roots: [
        { dir: modelFixtures, builtin: false },
        { dir: plainFixtures, builtin: false },
      ],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      openPanelIn: () => {},
      notify: () => {},
      readAssistSettings: () => (unreadable ? null : { assistant: settings }),
      assistKeys: createSecretStore({
        load: () => storedKeys,
        save: (data) => {
          storedKeys = data
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

  it('gives an extension only its own enabled providers and offers the usable models', async () => {
    host.approve('switchboard')
    const catalog = await until(() => (lastCatalog()?.models.length ? lastCatalog() : undefined))
    expect(labels(catalog)).toEqual(['Local/small', 'Local/big'])
    expect(catalog.models[0]).toEqual({
      ref: { extId: 'switchboard', provider: 'local', model: 'small' },
      group: 'Local',
      label: 'small',
      tools: 'prompted',
      points: ['command', 'chat'],
    })
    expect(catalog.chat).toEqual({ extId: 'switchboard', provider: 'local', model: 'small' })
    expect((await given()).entries).toEqual([
      {
        id: 'local',
        kind: 'plain',
        name: 'Local',
        baseUrl: '',
        models: ['small', 'big'],
        apiKey: null,
      },
      { id: 'hosted', kind: 'keyed', name: 'Hosted', baseUrl: '', models: ['large'], apiKey: null },
    ])
  })

  it('shows every provider with what it still needs, the kinds to add and no key values', () => {
    const [state] = host.assistOverview()
    expect(state.providers.map((p) => [p.id, p.setup])).toEqual([
      ['local', null],
      ['hosted', 'no-key'],
    ])
    expect(state.kinds).toEqual([
      { id: 'plain', title: 'Plain', baseUrl: 'http://plain.example/v1', key: 'optional' },
      { id: 'keyed', title: 'Keyed', baseUrl: '', key: 'required' },
    ])
    expect(state.keysSet).toEqual([])
  })

  it('uses the first model until the human picks one for chat and one for the fast features', async () => {
    expect(await host.assist('chat', chat('hi'))).toEqual({
      ok: true,
      result: { text: 'local/small answers hi' },
    })
    settings = {
      ...settings,
      chatModel: { extId: 'switchboard', provider: 'local', model: 'big' },
      fastModel: { extId: 'switchboard', provider: 'local', model: 'small' },
    }
    host.reloadAssistSettings()
    expect(host.assistCatalog().chat).toEqual({
      extId: 'switchboard',
      provider: 'local',
      model: 'big',
    })
    expect(await host.assist('chat', chat('hi'))).toEqual({
      ok: true,
      result: { text: 'local/big answers hi' },
    })
    expect(await host.assist('command', { query: 'list files' })).toEqual({
      ok: true,
      result: { suggestions: [{ command: 'local/small' }] },
    })
    expect(host.assistAvailability().chat).toEqual({
      extId: 'switchboard',
      name: 'Switchboard',
      label: 'Local · big',
      tools: 'native',
      ref: { extId: 'switchboard', provider: 'local', model: 'big' },
    })
  })

  it('sends one chat to the model it picked and refuses a model that is not offered', async () => {
    const picked = { extId: 'switchboard', provider: 'local', model: 'small' }
    expect(await host.assist('chat', chat('hi'), { model: picked })).toEqual({
      ok: true,
      result: { text: 'local/small answers hi' },
    })
    for (const model of [
      { extId: 'switchboard', provider: 'hosted', model: 'large' },
      { extId: 'switchboard', provider: 'parked', model: 'idle' },
      { extId: 'switchboard', provider: 'local', model: 'other' },
      { extId: 'nobody', provider: 'local', model: 'small' },
    ]) {
      expect(await host.assist('chat', chat('hi'), { model })).toEqual({
        ok: false,
        error: 'unavailable',
      })
    }
    expect(await host.assist('chat', chat('hi'), { model: 'big' })).toEqual({
      ok: false,
      error: 'invalid',
    })
  })

  it('stores a provider key encrypted and hands it only to the extension that runs it', async () => {
    const before = (await given()).events
    expect(host.setAssistProviderKey('hosted', 'sk-hosted-1')).toEqual({ ok: true })
    expect(JSON.stringify(storedKeys)).not.toContain('sk-hosted-1')
    const entries = await eventually(async () => {
      const now = await given()
      return now.events > before ? now.entries : undefined
    })
    expect(entries.find((e) => e.id === 'hosted')?.apiKey).toBe('sk-hosted-1')
    const catalog = await until(() =>
      lastCatalog()?.models.some((m) => m.ref.provider === 'hosted') ? lastCatalog() : undefined,
    )
    expect(labels(catalog)).toEqual(['Local/small', 'Local/big', 'Hosted/large'])
    const [state] = host.assistOverview()
    expect(state.keysSet).toEqual(['hosted'])
    expect(JSON.stringify(host.assistOverview())).not.toContain('sk-hosted-1')
    expect(JSON.stringify(broadcasts)).not.toContain('sk-hosted-1')
    expect(host.setAssistProviderKey('nope', 'x')).toEqual({ ok: false, error: 'unknown-provider' })
    expect(host.setAssistProviderKey('hosted', 5)).toEqual({ ok: false, error: 'invalid-value' })
  })

  it('offers a plain assist extension next to the providers and routes to it by choice', async () => {
    host.approve('oracle')
    const catalog = await until(() =>
      lastCatalog()?.models.some((m) => m.ref.extId === 'oracle') ? lastCatalog() : undefined,
    )
    expect(labels(catalog)).toEqual(['Local/small', 'Local/big', 'Hosted/large', 'Oracle/fake'])
    expect(catalog.chat).toEqual({ extId: 'switchboard', provider: 'local', model: 'big' })
    const chunks: string[] = []
    const res = await host.assist('chat', chat('list files'), {
      model: { extId: 'oracle' },
      onChunk: (text) => chunks.push(text),
    })
    expect(res).toEqual({ ok: true, result: { text: 'Use `ls -la` (0 context)' } })
    expect(await host.assist('terminal', { line: 'ls' })).toEqual({
      ok: false,
      error: 'unavailable',
    })
    settings = { ...settings, fastModel: { extId: 'oracle' } }
    host.reloadAssistSettings()
    expect(await host.assist('terminal', { line: 'ls' })).toMatchObject({ ok: true })
    expect(await host.assist('chat', chat('hi'))).toEqual({
      ok: true,
      result: { text: 'local/big answers hi' },
    })
  })

  it('does not fall back to another extension when the chosen one stops serving chat', async () => {
    settings = { ...settings, chatModel: { extId: 'oracle' } }
    host.reloadAssistSettings()
    expect(await host.assist('chat', chat('list files'))).toMatchObject({ ok: true })
    await host.invoke(
      'oracle',
      'status',
      { chat: { ready: false }, command: { ready: true }, terminal: { ready: true } },
      caller,
    )
    expect(host.assistAvailability().chat).toBeUndefined()
    expect(await host.assist('chat', chat('hi'))).toEqual({ ok: false, error: 'unavailable' })
  })

  it('answers nothing instead of another model when the chosen one is gone, until the human picks again', async () => {
    const before = settings
    settings = { ...settings, chatModel: { extId: 'switchboard', provider: 'gone', model: 'x' } }
    host.reloadAssistSettings()
    expect(host.assistCatalog().chat).toBeNull()
    expect(host.assistAvailability().chat).toBeUndefined()
    expect(await host.assist('chat', chat('hi'))).toEqual({ ok: false, error: 'unavailable' })
    settings = before
    host.reloadAssistSettings()
  })

  it('keeps every key when settings.json cannot be read', () => {
    const keys = JSON.stringify(storedKeys)
    unreadable = true
    host.reloadAssistSettings()
    unreadable = false
    expect(JSON.stringify(storedKeys)).toBe(keys)
    expect(host.assistOverview().find((o) => o.extId === 'switchboard')?.keysSet).toEqual([
      'hosted',
    ])
  })

  it('forgets the key of a removed provider and drops its models', async () => {
    settings = {
      ...settings,
      providers: (settings.providers ?? []).filter((p) => p.id !== 'hosted'),
    }
    host.reloadAssistSettings()
    expect(JSON.stringify(storedKeys)).not.toContain('hosted')
    await eventually(async () => ((await given()).entries.length === 1 ? true : undefined))
    const after = await until(() =>
      lastCatalog()?.models.every((m) => m.ref.provider !== 'hosted') ? lastCatalog() : undefined,
    )
    expect(labels(after)).toEqual(['Local/small', 'Local/big', 'Oracle/Oracle'])
    expect(host.assistCatalog().fast).toEqual({ extId: 'oracle' })
  })

  it('lists what one provider has so the human can add its models', async () => {
    expect(await host.assistModels('switchboard', 'local')).toEqual({
      ok: true,
      lifecycle: false,
      models: [{ id: 'local-listed' }],
    })
  })
})
