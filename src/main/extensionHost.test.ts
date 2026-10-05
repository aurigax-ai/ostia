import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES } from '../shared/capabilities'
import { ExtensionHost, type ExtensionHostDeps, loopbackOrigin } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerPane } from './idRegistry'

let base: string

function writeExt(root: string, id: string, manifest: Record<string, unknown>): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'ostia.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', api: '2.0', ...manifest }),
  )
  return dir
}

function makeHost(overrides: Partial<ExtensionHostDeps> = {}): {
  host: ExtensionHost
  deps: ExtensionHostDeps
} {
  const deps: ExtensionHostDeps = {
    roots: [
      { dir: join(base, 'builtin'), builtin: true },
      { dir: join(base, 'user'), builtin: false },
    ],
    store: new ExtensionStore(join(base, 'extensions.json')),
    socketPath: () => join(base, 'none.sock'),
    nodePath: process.execPath,
    workDirForWorkspace: () => undefined,
    broadcast: vi.fn(),
    openPanelIn: vi.fn(),
    notify: vi.fn(),
    log: () => {},
    ...overrides,
  }
  return { host: new ExtensionHost(deps), deps }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-ext-host-'))
  writeExt(join(base, 'builtin'), 'board', {
    capabilities: ['notify'],
    contributes: { panel: { title: 'Board', entry: 'panel.html' } },
  })
  writeExt(join(base, 'user'), 'tool', {
    capabilities: ['notify', 'browse'],
    main: 'main.js',
    contributes: {
      commands: [
        { id: 'go', title: 'Go' },
        { id: 'wide', title: 'Wide', capabilities: ['all-workspaces'] },
      ],
    },
  })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('ExtensionHost — approval and capabilities', () => {
  it('pre-approves built-ins and holds user extensions for the human', () => {
    const { host } = makeHost()
    const byId = Object.fromEntries(host.list().map((e) => [e.id, e]))
    expect(byId.board).toMatchObject({
      builtin: true,
      enabled: true,
      status: 'idle',
      granted: ['notify'],
      unapproved: [],
    })
    expect(byId.tool).toMatchObject({
      builtin: false,
      enabled: false,
      status: 'pending-approval',
      granted: [],
      unapproved: ['notify', 'browse'],
    })
  })

  it('approving grants exactly the declared caps, persists, and broadcasts the change', () => {
    const { host, deps } = makeHost()
    const list = host.approve('tool')
    expect(list.find((e) => e.id === 'tool')).toMatchObject({
      enabled: true,
      status: 'idle',
      granted: ['notify', 'browse'],
    })
    expect(deps.broadcast).toHaveBeenCalledWith('extensions:changed', list)
    const reloaded = makeHost()
      .host.list()
      .find((e) => e.id === 'tool')
    expect(reloaded?.status).toBe('idle')
  })

  it('grants only the approved subset when a later version asks for more', () => {
    const { host, deps } = makeHost()
    deps.store.set('tool', { enabled: true, approved: ['notify'] })
    expect(host.list().find((e) => e.id === 'tool')).toMatchObject({
      enabled: true,
      granted: ['notify'],
      unapproved: ['browse'],
    })
  })

  it('declining a pending extension records the review and keeps it disabled', () => {
    const { host, deps } = makeHost()
    host.setEnabled('tool', false)
    expect(deps.store.get('tool')).toEqual({ enabled: false, approved: [] })
    expect(host.list().find((e) => e.id === 'tool')?.status).toBe('disabled')
  })

  it('ignores records for extensions that no longer exist, such as removed built-ins', () => {
    writeFileSync(
      join(base, 'extensions.json'),
      JSON.stringify({
        kanban: { enabled: true, approved: ['read-board', 'board-write'] },
        wiki: { enabled: false, approved: ['wiki-read', 'wiki-write'] },
        tool: { enabled: true, approved: ['notify'] },
      }),
    )
    const { host } = makeHost()
    expect(
      host
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['board', 'tool'])
    expect(host.list().find((e) => e.id === 'tool')).toMatchObject({
      enabled: true,
      granted: ['notify'],
    })
    expect(host.setEnabled('kanban', false).map((e) => e.id)).not.toContain('kanban')
  })

  it('never grants more than was declared even when every cap is approved', () => {
    const { host, deps } = makeHost()
    deps.store.set('tool', { enabled: true, approved: [...ALL_CAPABILITIES] })
    expect(host.list().find((e) => e.id === 'tool')?.granted).toEqual(['notify', 'browse'])
  })
})

describe('ExtensionHost — settings page', () => {
  beforeEach(() => {
    writeExt(join(base, 'user'), 'paged', {
      contributes: {
        settings: { mode: { type: 'string', default: '', description: 'How it runs' } },
        settingsPage: { title: 'Paged', icon: 'kanban' },
      },
    })
  })

  it('sends the page only while the extension is enabled', () => {
    const { host } = makeHost()
    const paged = () => host.list().find((e) => e.id === 'paged')
    expect(paged()?.settingsPage).toBeNull()
    host.approve('paged')
    expect(paged()?.settingsPage).toEqual({ title: 'Paged', icon: 'kanban' })
    host.setEnabled('paged', false)
    expect(paged()?.settingsPage).toBeNull()
    expect(paged()?.settings.map((s) => s.key)).toEqual(['mode'])
  })

  it('sends none for an extension that asks for no page', () => {
    const { host } = makeHost()
    expect(host.list().find((e) => e.id === 'board')?.settingsPage).toBeNull()
  })
})

describe('ExtensionHost — command routing guards', () => {
  const caller = { kind: 'pane' as const, capabilities: [] }

  it('rejects unknown extensions, disabled extensions, and unknown commands', async () => {
    const { host } = makeHost()
    expect(await host.invoke('ghost', 'go', null, caller)).toMatchObject({
      ok: false,
      error: 'unknown-extension',
    })
    expect(await host.invoke('tool', 'go', null, caller)).toMatchObject({
      ok: false,
      error: 'extension-disabled',
    })
    host.approve('tool')
    expect(await host.invoke('tool', 'nope', null, caller)).toMatchObject({
      ok: false,
      error: 'unknown-command',
    })
  })

  it('refuses a command whose declared caps the caller lacks, before starting anything', async () => {
    const { host } = makeHost()
    host.approve('tool')
    expect(await host.invoke('tool', 'wide', null, caller)).toEqual({
      ok: false,
      error: 'needs-elevation',
      message: 'all-workspaces',
    })
    expect(host.list().find((e) => e.id === 'tool')?.status).toBe('idle')
  })

  it('reports the declared caps of a command for renderer-originated calls', () => {
    const { host } = makeHost()
    expect(host.commandCapabilities('tool', 'wide')).toEqual(['all-workspaces'])
    expect(host.commandCapabilities('tool', 'ghost')).toEqual([])
  })

  it('gives a pane caller its workspace workDir and its live terminal cwd', () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-cwd' })
    const { host } = makeHost({
      workDirForWorkspace: (sid) => (sid === 's1' ? '/proj' : undefined),
      cwdForPane: (paneId) => (paneId === 'p-cwd' ? '/proj/sub' : undefined),
    })
    expect(host.paneCaller(identity)).toMatchObject({
      kind: 'pane',
      paneId: identity.externalId,
      workspaceId: 's1',
      workDir: '/proj',
      cwd: '/proj/sub',
    })
  })

  it('SSH-C2 marks pane and user callers of a sandboxed workspace as sandboxed', () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 'ws-sbx', paneId: 'p-sbx' })
    const { host } = makeHost({ isSandboxed: (workspaceId) => workspaceId === 'ws-sbx' })
    expect(host.paneCaller(identity).sandboxed).toBe(true)
    expect(host.userCaller('ws-sbx').sandboxed).toBe(true)
  })

  it('SSH-C3 leaves sandboxed off a caller whose workspace is open or missing', () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 'ws-open', paneId: 'p-open' })
    const { host } = makeHost({ isSandboxed: (workspaceId) => workspaceId === 'ws-sbx' })
    expect(host.paneCaller(identity)).not.toHaveProperty('sandboxed')
    expect(host.userCaller('ws-open')).not.toHaveProperty('sandboxed')
    expect(host.userCaller(null)).not.toHaveProperty('sandboxed')
  })
})

describe('ExtensionHost — panels', () => {
  it('serves a file panel from inside the extension and allows only that directory', async () => {
    const { host } = makeHost()
    const res = await host.resolvePanel('board', { workspaceId: 's1', locale: 'en' })
    const file = join(base, 'builtin', 'board', 'panel.html')
    expect(res).toEqual({ ok: true, src: pathToFileURL(file).href })
    expect(host.isAllowedPanelUrl('board', pathToFileURL(file).href)).toBe(true)
    expect(host.isAllowedPanelUrl('board', pathToFileURL(join(base, 'user', 'x.html')).href)).toBe(
      false,
    )
    expect(host.isAllowedPanelUrl('board', 'https://example.com/')).toBe(false)
    expect(host.isAllowedPanelUrl('tool', pathToFileURL(file).href)).toBe(false)
  })

  it('refuses panels of disabled extensions', async () => {
    const { host } = makeHost()
    host.setEnabled('board', false)
    expect(await host.resolvePanel('board', { workspaceId: 's1', locale: 'en' })).toEqual({
      ok: false,
      error: 'extension-disabled',
    })
    expect(host.panelExtensionIds()).toEqual(['board'])
  })
})

describe('ExtensionHost — workflows', () => {
  it('offers contributed workflows only from enabled, approved extensions', () => {
    const flow = { name: 'Deploy', command: 'make deploy ENV={{env}}' }
    writeExt(join(base, 'builtin'), 'ops', { contributes: { workflows: [flow] } })
    writeExt(join(base, 'user'), 'mine', { contributes: { workflows: [flow] } })
    const { host } = makeHost()
    expect(host.workflows().map((w) => w.extId)).toEqual(['ops'])
    expect(host.workflows()[0].workflows[0]).toMatchObject({ name: 'Deploy', tags: [] })

    host.approve('mine')
    expect(host.workflows().map((w) => w.extId)).toEqual(['ops', 'mine'])

    host.setEnabled('ops', false)
    expect(host.workflows().map((w) => w.extId)).toEqual(['mine'])
  })
})

describe('loopbackOrigin', () => {
  it('accepts only plain-http loopback URLs', () => {
    expect(loopbackOrigin('http://127.0.0.1:4000/x?t=1')).toBe('http://127.0.0.1:4000')
    expect(loopbackOrigin('http://localhost:4000/')).toBe('http://localhost:4000')
    expect(loopbackOrigin('https://127.0.0.1:4000/')).toBeNull()
    expect(loopbackOrigin('http://192.168.1.2:4000/')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1.evil.com/')).toBeNull()
    expect(loopbackOrigin('file:///etc/passwd')).toBeNull()
    expect(loopbackOrigin('garbage')).toBeNull()
  })
})

describe('ExtensionHost — language servers', () => {
  const languageServers = [
    { id: 'alpha', name: 'Alpha', languages: ['python'], run: { program: 'alpha-ls' } },
    { id: 'beta', name: 'Beta', languages: ['go'], run: { node: 'server.js', args: ['--stdio'] } },
  ]

  beforeEach(() => {
    writeExt(join(base, 'builtin'), 'lsp-demo', {
      category: 'languages',
      capabilities: ['language-server'],
      contributes: {
        settings: { mode: { type: 'string', default: 'calm', description: 'Mode' } },
        languageServers,
      },
    })
    writeExt(join(base, 'user'), 'lsp-user', {
      capabilities: ['language-server'],
      contributes: { languageServers: [languageServers[0]] },
    })
  })

  it('lists every declared server with its state, folder and the extension’s setting values', () => {
    const { host } = makeHost({ readExtensionSettings: () => ({ 'lsp-demo': { mode: 'loud' } }) })
    const sources = host.languageServers()
    expect(sources.map((s) => [s.extId, s.server.id, s.state, s.builtin])).toEqual([
      ['lsp-demo', 'alpha', 'on', true],
      ['lsp-demo', 'beta', 'on', true],
      ['lsp-user', 'alpha', 'pending', false],
    ])
    expect(sources[0]).toMatchObject({
      extName: 'lsp-demo',
      dir: join(base, 'builtin', 'lsp-demo'),
      settingValues: { mode: 'loud' },
    })
    expect(host.list().find((e) => e.id === 'lsp-demo')?.languageServers).toEqual([
      { id: 'alpha', name: 'Alpha', languages: ['python'], command: 'alpha-ls' },
      { id: 'beta', name: 'Beta', languages: ['go'], command: 'server.js --stdio' },
    ])
  })

  it('switches one server off and on again, stores it, and tells whoever listens', () => {
    const onChanged = vi.fn()
    const { host, deps } = makeHost({ onChanged })
    host.setLanguageServerEnabled('lsp-demo', 'beta', false)
    expect(host.languageServers().map((s) => s.state)).toEqual(['on', 'off', 'pending'])
    expect(deps.store.get('lsp-demo')).toMatchObject({ enabled: true, serversOff: ['beta'] })
    expect(onChanged).toHaveBeenCalledTimes(1)
    host.setEnabled('lsp-demo', false)
    expect(deps.store.get('lsp-demo')).toMatchObject({ enabled: false, serversOff: ['beta'] })
    expect(
      host
        .languageServers()
        .slice(0, 2)
        .map((s) => s.state),
    ).toEqual(['off', 'off'])
    host.setLanguageServerEnabled('lsp-demo', 'beta', true)
    expect(
      host
        .languageServers()
        .slice(0, 2)
        .map((s) => s.state),
    ).toEqual(['on', 'on'])
    expect(deps.store.get('lsp-demo')?.serversOff).toBeUndefined()
  })

  it('ignores a server it does not know and an extension still waiting for approval', () => {
    const { host, deps } = makeHost()
    host.setLanguageServerEnabled('lsp-demo', 'gamma', false)
    host.setLanguageServerEnabled('lsp-user', 'alpha', true)
    host.setLanguageServerEnabled('missing', 'alpha', true)
    expect(deps.store.get('lsp-demo')).toBeUndefined()
    expect(deps.store.get('lsp-user')).toBeUndefined()
    expect(host.languageServers().map((s) => s.state)).toEqual(['on', 'on', 'pending'])
  })

  it('runs a user extension’s server only after the human approved it with the capability', () => {
    const { host, deps } = makeHost()
    host.approve('lsp-user')
    expect(host.languageServers()[2].state).toBe('on')
    deps.store.set('lsp-user', { enabled: true, approved: [] })
    expect(host.languageServers()[2].state).toBe('pending')
  })
})

describe('ExtensionHost agent plugins', () => {
  const kit = {
    capabilities: ['agent-plugin', 'notify'],
    main: 'main.js',
    contributes: {
      commands: [{ id: 'on-hook', title: 'Kit hook', palette: false, stdin: true }],
      agentSkills: [{ name: 'review', path: 'skills/review' }],
      agentHooks: [
        { event: 'SessionStart', command: 'on-hook' },
        { event: 'Notification', command: 'on-hook' },
      ],
    },
  }

  beforeEach(() => {
    writeExt(join(base, 'user'), 'kit', kit)
  })

  it('lists the skills and hooks an extension adds, for the approval dialog and Settings', () => {
    const { host } = makeHost()
    const info = host.list().find((e) => e.id === 'kit')
    expect(info?.status).toBe('pending-approval')
    expect(info?.agentSkills).toEqual(['kit-review'])
    expect(info?.agentHooks).toEqual([
      { event: 'SessionStart', command: 'on-hook', agents: ['claude', 'codex'] },
      { event: 'Notification', command: 'on-hook', agents: ['claude'] },
    ])
  })

  it('contributes nothing until the human approves the agent-plugin capability and enables it', () => {
    const { host, deps } = makeHost()
    expect(host.agentPlugins()).toEqual([])
    deps.store.set('kit', { enabled: true, approved: ['notify'] })
    expect(host.agentPlugins()).toEqual([])
    host.approve('kit')
    expect(host.agentPlugins()).toEqual([
      {
        extId: 'kit',
        dir: join(base, 'user', 'kit'),
        skills: [{ name: 'review', path: 'skills/review', files: [] }],
        hooks: kit.contributes.agentHooks,
      },
    ])
    host.setEnabled('kit', false)
    expect(host.agentPlugins()).toEqual([])
  })

  it('tells main to rebuild the agent plugin when an extension is approved or switched', () => {
    const onChanged = vi.fn()
    const { host } = makeHost({ onChanged })
    host.approve('kit')
    host.setEnabled('kit', false)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })
})
