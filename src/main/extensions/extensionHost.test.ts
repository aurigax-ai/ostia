import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALL_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { signExtension } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionSignature'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPane } from '../control/idRegistry'
import { ExtensionHost } from './extensionHost'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { ExtensionStore } from './extensionStore'
import {
  AcceptedVersions,
  OfficialRevocations,
  OfficialVerifier,
  VerdictStore,
} from './officialExtensions'

let base: string

function writeExt(root: string, id: string, manifest: Record<string, unknown>): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'ostia.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', api: '7.0', ...manifest }),
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
    isSandboxed: () => false,
    sandboxDomains: () => null,
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
    const list = host.processes.approve('tool')
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
    host.processes.setEnabled('tool', false)
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
    expect(host.processes.setEnabled('kanban', false).map((e) => e.id)).not.toContain('kanban')
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
    host.processes.approve('paged')
    expect(paged()?.settingsPage).toEqual({ title: 'Paged', icon: 'kanban' })
    host.processes.setEnabled('paged', false)
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
    host.processes.approve('tool')
    expect(await host.invoke('tool', 'nope', null, caller)).toMatchObject({
      ok: false,
      error: 'unknown-command',
    })
  })

  it('refuses a command whose declared caps the caller lacks, before starting anything', async () => {
    const { host } = makeHost()
    host.processes.approve('tool')
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

  it('marks a pane caller agentRunning only while main says its pane runs an agent', () => {
    const agent = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-agent' })
    const shell = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-shell' })
    const { host } = makeHost({ agentRunning: (paneId) => paneId === 'p-agent' })
    expect(host.paneCaller(agent).agentRunning).toBe(true)
    expect(host.paneCaller(shell)).not.toHaveProperty('agentRunning')
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
    const res = await host.panels.resolvePanel('board', { workspaceId: 's1', locale: 'en' })
    const file = join(base, 'builtin', 'board', 'panel.html')
    expect(res).toEqual({ ok: true, src: pathToFileURL(file).href })
    expect(host.panels.isAllowedPanelUrl('board', pathToFileURL(file).href)).toBe(true)
    expect(
      host.panels.isAllowedPanelUrl('board', pathToFileURL(join(base, 'user', 'x.html')).href),
    ).toBe(false)
    expect(host.panels.isAllowedPanelUrl('board', 'https://example.com/')).toBe(false)
    expect(host.panels.isAllowedPanelUrl('tool', pathToFileURL(file).href)).toBe(false)
  })

  it('refuses panels of disabled extensions', async () => {
    const { host } = makeHost()
    host.processes.setEnabled('board', false)
    expect(await host.panels.resolvePanel('board', { workspaceId: 's1', locale: 'en' })).toEqual({
      ok: false,
      error: 'extension-disabled',
    })
    expect(host.panels.panelExtensionIds()).toEqual(['board'])
  })
})

describe('ExtensionHost — snippets', () => {
  it('offers contributed snippets only from enabled, approved extensions', () => {
    const flow = { name: 'Deploy', command: 'make deploy ENV={{env}}' }
    writeExt(join(base, 'builtin'), 'ops', { contributes: { snippets: [flow] } })
    writeExt(join(base, 'user'), 'mine', { contributes: { snippets: [flow] } })
    const { host } = makeHost()
    expect(host.contributions.snippets().map((w) => w.extId)).toEqual(['ops'])
    expect(host.contributions.snippets()[0].snippets[0]).toMatchObject({ name: 'Deploy', tags: [] })

    host.processes.approve('mine')
    expect(host.contributions.snippets().map((w) => w.extId)).toEqual(['ops', 'mine'])

    host.processes.setEnabled('ops', false)
    expect(host.contributions.snippets().map((w) => w.extId)).toEqual(['mine'])
  })
})

describe('ExtensionHost — completions', () => {
  it('serves completion specs from the folder an enabled extension contributes', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../extensions/completions/ostia.json', import.meta.url), 'utf8'),
    )
    writeExt(join(base, 'builtin'), 'completions', { contributes: manifest.contributes })
    const { host } = makeHost()
    expect(host.contributions.completionDirs()).toEqual([
      join(base, 'builtin', 'completions', 'specs'),
    ])
    host.processes.setEnabled('completions', false)
    expect(host.contributions.completionDirs()).toEqual([])
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
    const sources = host.contributions.languageServers()
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
    host.contributions.setLanguageServerEnabled('lsp-demo', 'beta', false)
    expect(host.contributions.languageServers().map((s) => s.state)).toEqual([
      'on',
      'off',
      'pending',
    ])
    expect(deps.store.get('lsp-demo')).toMatchObject({ enabled: true, serversOff: ['beta'] })
    expect(onChanged).toHaveBeenCalledTimes(1)
    host.processes.setEnabled('lsp-demo', false)
    expect(deps.store.get('lsp-demo')).toMatchObject({ enabled: false, serversOff: ['beta'] })
    expect(
      host.contributions
        .languageServers()
        .slice(0, 2)
        .map((s) => s.state),
    ).toEqual(['off', 'off'])
    host.contributions.setLanguageServerEnabled('lsp-demo', 'beta', true)
    expect(
      host.contributions
        .languageServers()
        .slice(0, 2)
        .map((s) => s.state),
    ).toEqual(['on', 'on'])
    expect(deps.store.get('lsp-demo')?.serversOff).toBeUndefined()
  })

  it('ignores a server it does not know and an extension still waiting for approval', () => {
    const { host, deps } = makeHost()
    host.contributions.setLanguageServerEnabled('lsp-demo', 'gamma', false)
    host.contributions.setLanguageServerEnabled('lsp-user', 'alpha', true)
    host.contributions.setLanguageServerEnabled('missing', 'alpha', true)
    expect(deps.store.get('lsp-demo')).toBeUndefined()
    expect(deps.store.get('lsp-user')).toBeUndefined()
    expect(host.contributions.languageServers().map((s) => s.state)).toEqual([
      'on',
      'on',
      'pending',
    ])
  })

  it('runs a user extension’s server only after the human approved it with the capability', () => {
    const { host, deps } = makeHost()
    host.processes.approve('lsp-user')
    expect(host.contributions.languageServers()[2].state).toBe('on')
    deps.store.set('lsp-user', { enabled: true, approved: [] })
    expect(host.contributions.languageServers()[2].state).toBe('pending')
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
    expect(host.contributions.agentPlugins()).toEqual([])
    deps.store.set('kit', { enabled: true, approved: ['notify'] })
    expect(host.contributions.agentPlugins()).toEqual([])
    host.processes.approve('kit')
    expect(host.contributions.agentPlugins()).toEqual([
      {
        extId: 'kit',
        builtin: false,
        dir: join(base, 'user', 'kit'),
        skills: [{ name: 'review', path: 'skills/review', files: [] }],
        hooks: kit.contributes.agentHooks,
      },
    ])
    host.processes.setEnabled('kit', false)
    expect(host.contributions.agentPlugins()).toEqual([])
  })

  it('tells main to rebuild the agent plugin when an extension is approved or switched', () => {
    const onChanged = vi.fn()
    const { host } = makeHost({ onChanged })
    host.processes.approve('kit')
    host.processes.setEnabled('kit', false)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })
})

describe('ExtensionHost — browse kinds', () => {
  const kind = (id: string, ...patterns: string[]) => ({
    id,
    displayName: id,
    selector: patterns.map((filenamePattern) => ({ filenamePattern })),
    browse: {},
  })
  const browser = (extra: Record<string, unknown> = {}) => ({
    capabilities: ['file-contents'],
    main: 'main.js',
    ...extra,
  })

  beforeEach(() => {
    writeExt(
      join(base, 'builtin'),
      'zips',
      browser({ contributes: { fileKinds: [kind('zips.zip', '*.zip')] } }),
    )
    writeExt(
      join(base, 'user'),
      'rival',
      browser({
        contributes: {
          fileKinds: [
            kind('rival.zip', '*.zip'),
            kind('rival.rar', '*.rar'),
            kind('rival.gz', '*.tar.gz'),
          ],
        },
      }),
    )
  })

  it('serves a file from a built-in kind with no approval, and lists the role in the info', () => {
    const { host } = makeHost()
    expect(host.browse.kindFor('/w/a.zip')).toEqual({ extId: 'zips', kind: 'zips.zip' })
    expect(host.list().find((e) => e.id === 'zips')?.fileKinds).toEqual([
      {
        id: 'zips.zip',
        displayName: 'zips.zip',
        selector: [{ filenamePattern: '*.zip' }],
        browse: true,
        approved: true,
      },
    ])
  })

  it('grants file-contents to a built-in only when it declares a browse kind', () => {
    writeExt(join(base, 'builtin'), 'peeker', {
      capabilities: ['file-contents'],
      contributes: {},
    })
    const { host } = makeHost()
    const byId = Object.fromEntries(host.list().map((e) => [e.id, e]))
    expect(byId.zips.granted).toContain('file-contents')
    expect(byId.board.granted).not.toContain('file-contents')
    expect(byId.peeker).toMatchObject({ granted: [], unapproved: ['file-contents'] })
  })

  it('gives a built-in that already has a stored record the file-contents its manifest now declares', () => {
    const { host, deps } = makeHost()
    deps.store.set('zips', { enabled: true, approved: ['notify'] })
    const zips = host.list().find((e) => e.id === 'zips')
    expect(zips?.granted).toContain('file-contents')
    expect(host.browse.kindFor('/w/a.zip')).toEqual({ extId: 'zips', kind: 'zips.zip' })
    deps.store.set('rival', { enabled: true, approved: ['notify'] })
    expect(host.list().find((e) => e.id === 'rival')?.granted).not.toContain('file-contents')
  })

  it('serves nothing from a user extension until the human approved its claim', () => {
    const { host } = makeHost()
    expect(host.browse.kindFor('/w/a.rar')).toBeNull()
    host.processes.approve('rival')
    expect(host.browse.kindFor('/w/a.rar')).toEqual({ extId: 'rival', kind: 'rival.rar' })
  })

  it('lets the built-in win a shared pattern and the longest pattern win otherwise', () => {
    const { host } = makeHost()
    host.processes.approve('rival')
    expect(host.browse.kindFor('/w/a.zip')?.extId).toBe('zips')
    writeExt(
      join(base, 'builtin'),
      'gzips',
      browser({ contributes: { fileKinds: [kind('gzips.gz', '*.gz')] } }),
    )
    const again = makeHost().host
    again.processes.approve('rival')
    expect(again.browse.kindFor('/w/a.tar.gz')).toEqual({ extId: 'gzips', kind: 'gzips.gz' })
  })

  it('says on the loser which patterns it does not serve and who does', () => {
    const { host } = makeHost()
    host.processes.approve('rival')
    const rival = host.list().find((e) => e.id === 'rival')
    expect(rival?.fileKinds.find((k) => k.id === 'rival.zip')?.shadowed).toEqual([
      { name: 'zips', patterns: ['*.zip'] },
    ])
    expect(rival?.fileKinds.find((k) => k.id === 'rival.rar')?.shadowed).toBeUndefined()
    expect(host.list().find((e) => e.id === 'zips')?.fileKinds[0].shadowed).toBeUndefined()
  })

  it('skips a kind whose capability was not granted, whose claim widened, or that is disabled', () => {
    const { host, deps } = makeHost()
    host.processes.approve('rival')
    const claims = deps.store.get('rival')?.approvedKinds ?? []
    deps.store.set('rival', { enabled: true, approved: [], approvedKinds: claims })
    host.processes.reloadRecords()
    expect(host.browse.kindFor('/w/a.rar')).toBeNull()
    deps.store.set('rival', {
      enabled: true,
      approved: ['file-contents'],
      approvedKinds: claims.filter((claim) => !claim.startsWith('rival.rar')),
    })
    host.processes.reloadRecords()
    expect(host.browse.kindFor('/w/a.rar')).toBeNull()
    expect(host.browse.kindFor('/w/a.tar.gz')).toEqual({ extId: 'rival', kind: 'rival.gz' })
    host.processes.setEnabled('rival', false)
    expect(host.browse.kindFor('/w/a.tar.gz')).toBeNull()
  })

  it('tells the Files tree when a built-in is turned off before anything changed', () => {
    const onBrowseKindsChanged = vi.fn()
    const { host } = makeHost({ onBrowseKindsChanged })
    host.processes.setEnabled('zips', false)
    expect(onBrowseKindsChanged).toHaveBeenCalledTimes(1)
    expect(host.browse.kindFor('/w/a.zip')).toBeNull()
  })

  it('tells the Files tree when the kinds that are served change', () => {
    const onBrowseKindsChanged = vi.fn()
    const { host } = makeHost({ onBrowseKindsChanged })
    host.processes.approve('rival')
    expect(onBrowseKindsChanged).toHaveBeenCalledTimes(1)
    host.processes.setEnabled('rival', false)
    expect(onBrowseKindsChanged).toHaveBeenCalledTimes(2)
    host.processes.setEnabled('rival', false)
    expect(onBrowseKindsChanged).toHaveBeenCalledTimes(2)
  })
})

describe('ExtensionHost human prompt claim', () => {
  const recorder = {
    capabilities: ['agent-plugin'],
    main: 'main.js',
    contributes: {
      commands: [
        { id: 'on-prompt', title: 'Prompt', palette: false, stdin: true },
        { id: 'on-start', title: 'Start', palette: false, stdin: true },
      ],
      agentHooks: [
        { event: 'UserPromptSubmit', command: 'on-prompt' },
        { event: 'SessionStart', command: 'on-start' },
      ],
    },
  }

  beforeEach(() => {
    writeExt(join(base, 'user'), 'recorder', recorder)
  })

  function pane() {
    return registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-prompt' })
  }

  it('marks the caller of an approved extension’s prompt hook while main attributes the line to the human', () => {
    const claim = vi.fn().mockReturnValue('fix the cart')
    const { host, deps } = makeHost({ claimHumanPrompt: claim })
    deps.store.set('recorder', { enabled: true, approved: ['agent-plugin'] })
    host.processes.approve('recorder')
    const identity = pane()
    const caller = host.paneCaller(identity, { extId: 'recorder', command: 'on-prompt' })
    expect(caller.humanPrompt).toBe('fix the cart')
    expect(claim).toHaveBeenCalledWith('p-prompt', 'recorder')
  })

  it('leaves the bit off, and unclaimed, for any other command, event or caller', () => {
    const claim = vi.fn().mockReturnValue('fix the cart')
    const { host, deps } = makeHost({ claimHumanPrompt: claim })
    deps.store.set('recorder', { enabled: true, approved: ['agent-plugin'] })
    host.processes.approve('recorder')
    const identity = pane()
    expect(
      host.paneCaller(identity, { extId: 'recorder', command: 'on-start' }),
    ).not.toHaveProperty('humanPrompt')
    expect(host.paneCaller(identity, { extId: 'recorder', command: 'missing' })).not.toHaveProperty(
      'humanPrompt',
    )
    expect(
      host.paneCaller(identity, { extId: 'unknown', command: 'on-prompt' }),
    ).not.toHaveProperty('humanPrompt')
    expect(host.paneCaller(identity)).not.toHaveProperty('humanPrompt')
    expect(host.userCaller('s1')).not.toHaveProperty('humanPrompt')
    expect(claim).not.toHaveBeenCalled()
  })

  it('leaves the bit off before the human approves agent-plugin, and when main attributes nothing', () => {
    const claim = vi.fn().mockReturnValue(false)
    const { host, deps } = makeHost({ claimHumanPrompt: claim })
    const identity = pane()
    expect(
      host.paneCaller(identity, { extId: 'recorder', command: 'on-prompt' }),
    ).not.toHaveProperty('humanPrompt')
    expect(claim).not.toHaveBeenCalled()
    deps.store.set('recorder', { enabled: true, approved: ['agent-plugin'] })
    host.processes.approve('recorder')
    expect(
      host.paneCaller(identity, { extId: 'recorder', command: 'on-prompt' }),
    ).not.toHaveProperty('humanPrompt')
    expect(claim).toHaveBeenCalledTimes(1)
  })
})

describe('ExtensionHost — agent skill problems', () => {
  function writeSkilled(id: string, skill: string): void {
    const dir = writeExt(join(base, 'user'), id, {
      capabilities: ['agent-plugin'],
      contributes: { agentSkills: [{ name: 'review', path: 'skills/review' }] },
    })
    mkdirSync(join(dir, 'skills', 'review'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'review', 'SKILL.md'), skill)
  }

  it('lists why an installed extension’s skill is refused, and nothing for a clean one', () => {
    writeSkilled('clean', '---\nname: review\ndescription: Use when reviewing.\n---\nBody\n')
    writeSkilled(
      'greedy',
      '---\nname: review\ndescription: Use when reviewing.\nallowed-tools: Bash(*)\n---\nBody\n',
    )
    writeSkilled('shelly', '---\nname: review\ndescription: Use when reviewing.\n---\nNow: !`id`\n')
    const byId = Object.fromEntries(
      makeHost()
        .host.list()
        .map((e) => [e.id, e]),
    )
    expect(byId.clean?.agentSkillProblems).toEqual([])
    expect(byId.tool?.agentSkillProblems).toEqual([])
    expect(byId.greedy?.agentSkillProblems).toEqual([
      "agent skill 'review': SKILL.md: line 4: 'allowed-tools' is not allowed, a skill carries only name and description",
    ])
    expect(byId.shelly?.agentSkillProblems).toEqual([
      "agent skill 'review': SKILL.md: line 5: shell injection (!` or a ```! block) is not allowed",
    ])
  })
})

describe('ExtensionHost — a built-in updated from the official marketplace', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  function update(version: string, sign: boolean, caps: string[] = ['notify']): void {
    const dir = writeExt(join(base, 'user'), 'board', {
      version,
      capabilities: caps,
      contributes: { panel: { title: 'Board', entry: 'panel.html' } },
    })
    if (sign) signExtension(dir, 'board', version, privatePem)
  }

  async function host(
    opts: {
      key?: string | null
      revoked?: string[]
      updatable?: string[]
      seen?: string
      verdicts?: VerdictStore
    } = {},
  ): Promise<ExtensionHost> {
    writeFileSync(join(base, 'revoked.json'), JSON.stringify(opts.revoked ?? []))
    if (opts.seen) writeFileSync(join(base, 'seen.json'), JSON.stringify({ board: opts.seen }))
    let rescan = (): void => {}
    const verifier = new OfficialVerifier({
      publicKey: () => (opts.key === null ? undefined : (opts.key ?? publicDer)),
      revocations: new OfficialRevocations(join(base, 'revoked.json')),
      accepted: new AcceptedVersions(join(base, 'seen.json')),
      onVerified: () => rescan(),
      recordAccepted: true,
      ...(opts.verdicts ? { verdicts: opts.verdicts } : {}),
      updatable: opts.updatable ?? ['board'],
    })
    const { host: created } = makeHost({ officialUpdate: verifier.check })
    rescan = () => created.processes.rescan()
    await verifier.settled()
    return created
  }

  const board = (h: ExtensionHost) => h.list().find((e) => e.id === 'board')

  it('runs a signed newer copy with the built-in powers once it is verified', async () => {
    update('2.0.0', true)
    expect(board(await host())).toMatchObject({
      builtin: true,
      version: '2.0.0',
      enabled: true,
      unapproved: [],
    })
  })

  it('does not start the bundled copy while the update is being verified, and remembers the verdict', async () => {
    update('2.0.0', true)
    const verdicts = new VerdictStore(join(base, 'verdicts.json'))
    const make = (store: VerdictStore) =>
      new OfficialVerifier({
        publicKey: () => publicDer,
        revocations: new OfficialRevocations(join(base, 'revoked.json')),
        accepted: new AcceptedVersions(join(base, 'seen.json')),
        onVerified: () => {},
        recordAccepted: true,
        verdicts: store,
        updatable: ['board'],
      })
    const first = make(verdicts)
    expect(board(makeHost({ officialUpdate: first.check }).host)).toBeUndefined()
    await first.settled()
    expect(statSync(join(base, 'verdicts.json')).mode & 0o777).toBe(0o600)
    expect(board(makeHost({ officialUpdate: make(verdicts).check }).host)).toMatchObject({
      builtin: true,
      version: '2.0.0',
    })
  })

  it('verifies again when the folder changes, even to the same size', async () => {
    update('2.0.0', true)
    const verdicts = new VerdictStore(join(base, 'verdicts.json'))
    expect(board(await host({ verdicts }))).toMatchObject({ version: '2.0.0' })
    writeFileSync(join(base, 'user/board/panel.html'), '<p>tampered</p>')
    expect(board(await host({ verdicts }))).toMatchObject({ version: '1.0.0' })
  })

  it('keeps the bundled copy for an unsigned, tampered, downgraded or revoked one', async () => {
    update('2.0.0', false)
    expect(board(await host())).toMatchObject({ builtin: true, version: '1.0.0' })

    update('2.0.0', true)
    writeFileSync(join(base, 'user/board/panel.html'), '<script>steal()</script>')
    expect(board(await host())).toMatchObject({ builtin: true, version: '1.0.0' })

    update('0.9.0', true)
    expect(board(await host())).toMatchObject({ builtin: true, version: '1.0.0' })

    update('2.0.0', true)
    expect(board(await host({ key: null }))).toMatchObject({ version: '1.0.0' })
    expect(board(await host({ revoked: ['board@2.0.0'] }))).toMatchObject({ version: '1.0.0' })
  })

  it('refuses a copy signed by another key', async () => {
    update('2.0.0', true)
    const other = generateKeyPairSync('ed25519').publicKey
    const otherDer = other.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(board(await host({ key: otherDer }))).toMatchObject({ version: '1.0.0' })
  })

  it('refuses a signed copy that raises a capability, however it is signed', async () => {
    update('2.0.0', true, ['notify', 'browse'])
    expect(board(await host())).toMatchObject({ version: '1.0.0' })
  })

  it('refuses a built-in that is not on the allowlist', async () => {
    update('2.0.0', true)
    expect(board(await host({ updatable: ['csv'] }))).toMatchObject({ version: '1.0.0' })
  })

  it('refuses a version below the highest one accepted before', async () => {
    update('1.5.0', true)
    expect(board(await host({ seen: '2.0.0' }))).toMatchObject({ version: '1.0.0' })
    expect(board(await host({ seen: '1.2.0' }))).toMatchObject({ version: '1.5.0' })
    expect(JSON.parse(readFileSync(join(base, 'seen.json'), 'utf8')).board).toBe('1.5.0')
  })
})
