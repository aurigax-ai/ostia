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
    join(dir, 'pine.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', ...manifest }),
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
    workDirForSession: () => undefined,
    broadcast: vi.fn(),
    openPanelIn: vi.fn(),
    notify: vi.fn(),
    log: () => {},
    ...overrides,
  }
  return { host: new ExtensionHost(deps), deps }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pine-ext-host-'))
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
        { id: 'wide', title: 'Wide', capabilities: ['workspace-wide'] },
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

  it('never grants more than was declared even when every cap is approved', () => {
    const { host, deps } = makeHost()
    deps.store.set('tool', { enabled: true, approved: [...ALL_CAPABILITIES] })
    expect(host.list().find((e) => e.id === 'tool')?.granted).toEqual(['notify', 'browse'])
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
      message: 'workspace-wide',
    })
    expect(host.list().find((e) => e.id === 'tool')?.status).toBe('idle')
  })

  it('reports the declared caps of a command for renderer-originated calls', () => {
    const { host } = makeHost()
    expect(host.commandCapabilities('tool', 'wide')).toEqual(['workspace-wide'])
    expect(host.commandCapabilities('tool', 'ghost')).toEqual([])
  })

  it('gives a pane caller its session workDir and its live terminal cwd', () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-cwd' })
    const { host } = makeHost({
      workDirForSession: (sid) => (sid === 's1' ? '/proj' : undefined),
      cwdForPane: (paneId) => (paneId === 'p-cwd' ? '/proj/sub' : undefined),
    })
    expect(host.paneCaller(identity)).toMatchObject({
      kind: 'pane',
      paneId: identity.externalId,
      sessionId: 's1',
      workDir: '/proj',
      cwd: '/proj/sub',
    })
  })
})

describe('ExtensionHost — panels', () => {
  it('serves a file panel from inside the extension and allows only that directory', async () => {
    const { host } = makeHost()
    const res = await host.resolvePanel('board', { sessionId: 's1', locale: 'en' })
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
    expect(await host.resolvePanel('board', { sessionId: 's1', locale: 'en' })).toEqual({
      ok: false,
      error: 'extension-disabled',
    })
    expect(host.panelExtensionIds()).toEqual(['board'])
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
