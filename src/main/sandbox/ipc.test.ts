import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS } from '../../shared/sandbox/sandbox'
import { ViolationLog, parseViolationLine } from './violations'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

const { registerSandboxIpc } = await import('./ipc')
const { SandboxStore } = await import('./store')
const { WorkspaceSandboxes } = await import('./workspaceSandboxes')

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-sbx-ipc-')))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function sender(id: number) {
  return { sender: { id } }
}

describe('sandbox IPC', () => {
  it('SBX-C8 refuses to change the sandbox from a window that does not show the workspace', async () => {
    const store = new SandboxStore(join(root, 'sandbox.json'))
    const sandboxes = new WorkspaceSandboxes({
      store,
      globals: () => DEFAULT_SANDBOX_GLOBALS,
      basePaths: () => ({ home: root, dataDirs: [], socketPath: '', runtimeReads: [] }),
      workDir: () => join(root, 'proj'),
      tmpRoot: join(root, 'tmp'),
      nodePath: process.execPath,
      hostScript: '',
      onAsk: async () => false,
    })
    registerSandboxIpc({ sandboxes, ownerWindow: (id) => (id === 'ws' ? '1' : undefined) })
    const setEnabled = handlers.get('sandbox:set-enabled')
    const get = handlers.get('sandbox:get')
    expect(await setEnabled?.(sender(2), 'ws', true)).toEqual({ ok: false, reason: 'not-owned' })
    expect(await get?.(sender(2), 'ws')).toBeNull()
    expect(store.get('ws').enabled).toBe(false)
    expect(await setEnabled?.(sender(1), 'ws', 'yes')).toEqual({ ok: false, reason: 'not-owned' })
    expect(store.get('ws').enabled).toBe(false)
    expect(await setEnabled?.(sender(1), 'ws', true)).toMatchObject({
      ok: true,
      settings: { enabled: true },
    })
    expect(store.get('ws').enabled).toBe(true)
  })

  it('lists the tool-folder presets found under the home folder, to any window', async () => {
    const home = join(root, 'presets-home')
    mkdirSync(join(home, '.volta'), { recursive: true })
    const sandboxes = new WorkspaceSandboxes({
      store: new SandboxStore(join(root, 'presets.json')),
      globals: () => DEFAULT_SANDBOX_GLOBALS,
      basePaths: () => ({ home, dataDirs: [], socketPath: '', runtimeReads: [] }),
      workDir: () => join(home, 'proj'),
      tmpRoot: join(root, 'tmp'),
      nodePath: process.execPath,
      hostScript: '',
      onAsk: async () => false,
    })
    registerSandboxIpc({ sandboxes, ownerWindow: () => undefined })
    expect(await handlers.get('sandbox:presets')?.(sender(9))).toEqual([
      { id: 'volta', paths: ['~/.volta'] },
    ])
  })

  it('SBX-C96 refuses to turn the sandbox on while a required program is missing', async () => {
    const store = new SandboxStore(join(root, 'c96.json'))
    const sandboxes = new WorkspaceSandboxes({
      store,
      globals: () => DEFAULT_SANDBOX_GLOBALS,
      basePaths: () => ({ home: root, dataDirs: [], socketPath: '', runtimeReads: [] }),
      workDir: () => join(root, 'proj'),
      tmpRoot: join(root, 'tmp'),
      nodePath: process.execPath,
      hostScript: '',
      onAsk: async () => false,
    })
    let missing = [{ program: 'bwrap', package: 'bubblewrap' }]
    registerSandboxIpc({ sandboxes, ownerWindow: () => '1', missing: () => missing })
    const setEnabled = handlers.get('sandbox:set-enabled')
    expect(await setEnabled?.(sender(1), 'ws', true)).toEqual({
      ok: false,
      reason: 'missing-programs',
    })
    expect(store.has('ws')).toBe(false)
    missing = []
    expect(await setEnabled?.(sender(1), 'ws', true)).toMatchObject({
      ok: true,
      settings: { enabled: true },
    })
    missing = [{ program: 'bwrap', package: 'bubblewrap' }]
    expect(await setEnabled?.(sender(1), 'ws', false)).toMatchObject({
      ok: true,
      settings: { enabled: false },
    })
  })
})

function setup(name: string, workDirs: Record<string, string> = {}) {
  const home = join(root, name, 'home')
  const dataDir = join(home, '.local/share/ostia')
  const runtimeDir = join(root, name, 'run')
  const workDir = join(home, 'proj')
  for (const dir of [workDir, dataDir, runtimeDir, join(home, 'builds'), join(home, 'notes')]) {
    mkdirSync(dir, { recursive: true })
  }
  const store = new SandboxStore(join(root, `${name}.json`))
  const sandboxes = new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home,
      dataDirs: [dataDir],
      runtimeDir,
      socketPath: join(runtimeDir, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: (id) => workDirs[id] ?? workDir,
    tmpRoot: join(root, name, 'tmp'),
    nodePath: process.execPath,
    hostScript: '',
    onAsk: async () => false,
  })
  const violations = new ViolationLog(() => 5)
  registerSandboxIpc({
    sandboxes,
    violations,
    ownerWindow: (id) => (id === 'other' ? '2' : '1'),
  })
  const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)?.(...args)
  return { home, dataDir, runtimeDir, workDir, store, sandboxes, violations, call }
}

describe('sandbox filesystem IPC', () => {
  it('stores a writable, hidden and read-only path only for the window that shows the workspace', async () => {
    const { store, call } = setup('paths')
    expect(await call('sandbox:set-paths', sender(2), 'ws', 'allowWrite', ['~/builds'])).toEqual({
      ok: false,
      errors: [],
    })
    expect(store.get('ws').allowWrite).toBeUndefined()
    expect(
      await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', ['~/builds']),
    ).toMatchObject({ ok: true, settings: { allowWrite: ['~/builds'] } })
    await call('sandbox:set-paths', sender(1), 'ws', 'denyRead', ['~/notes'])
    await call('sandbox:set-paths', sender(1), 'ws', 'denyWrite', ['~/builds'])
    expect(store.get('ws')).toMatchObject({
      allowWrite: ['~/builds'],
      denyRead: ['~/notes'],
      denyWrite: ['~/builds'],
    })
  })

  it('refuses a list name it does not know', async () => {
    const { store, call } = setup('kind')
    expect(await call('sandbox:set-paths', sender(1), 'ws', 'enabled', ['~/builds'])).toEqual({
      ok: false,
      errors: [],
    })
    expect(await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', 'x')).toEqual({
      ok: false,
      errors: [],
    })
    expect(store.has('ws')).toBe(false)
  })

  it('refuses to make Ostia data, the socket folder or a protected agent file writable', async () => {
    const { store, dataDir, runtimeDir, call } = setup('guard')
    const refused = await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', [
      dataDir,
      runtimeDir,
      '~/.claude/settings.json',
      '~',
    ])
    expect(refused).toEqual({
      ok: false,
      errors: [
        { value: dataDir, reason: 'ostia-data' },
        { value: runtimeDir, reason: 'protected' },
        { value: '~/.claude/settings.json', reason: 'protected' },
        { value: '~', reason: 'too-broad' },
      ],
    })
    expect(store.has('ws')).toBe(false)
  })

  it('checks only the entries being added, so a stored path that vanished never blocks an edit', async () => {
    const { home, store, call } = setup('vanished')
    await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', ['~/builds'])
    rmSync(join(home, 'builds'), { recursive: true })
    expect(
      await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', ['~/builds', '~/notes']),
    ).toMatchObject({ ok: true })
    expect(store.get('ws').allowWrite).toEqual(['~/builds', '~/notes'])
    await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', [])
    expect(store.get('ws').allowWrite).toBeUndefined()
  })

  it('checks a global path for any window without storing anything', async () => {
    const { runtimeDir, store, call } = setup('check')
    expect(await call('sandbox:check-paths', sender(9), 'allowWrite', ['~/builds'])).toEqual([])
    expect(await call('sandbox:check-paths', sender(9), 'allowWrite', [runtimeDir, 'rel'])).toEqual(
      [
        { value: runtimeDir, reason: 'protected' },
        { value: 'rel', reason: 'not-absolute' },
      ],
    )
    expect(await call('sandbox:check-paths', sender(9), 'nope', ['~/builds'])).toEqual([
      { value: '', reason: 'invalid' },
    ])
    expect(store.has('ws')).toBe(false)
  })

  it('lists what Ostia always allows and hides only to the window that shows the workspace', async () => {
    const { home, workDir, call } = setup('fixed')
    expect(await call('sandbox:fixed-policy', sender(2), 'ws')).toBeNull()
    const fixed = (await call('sandbox:fixed-policy', sender(1), 'ws')) as {
      hidden: string[]
      writable: string[]
    }
    expect(fixed.hidden).toContain(home)
    expect(fixed.writable).toContain(workDir)
    const base = (await call('sandbox:fixed-policy', sender(2), undefined)) as {
      writable: string[]
    }
    expect(base.writable).not.toContain(workDir)
  })
})

describe('sandbox switches and domains IPC', () => {
  it('turns Unix sockets off only for the owner window and only with known boolean switches', async () => {
    const { store, call } = setup('switches')
    expect(await call('sandbox:set-switches', sender(2), 'ws', { unixSockets: false })).toBeNull()
    expect(await call('sandbox:set-switches', sender(1), 'ws', { unixSockets: 'no' })).toBeNull()
    expect(await call('sandbox:set-switches', sender(1), 'ws', undefined)).toBeNull()
    expect(store.has('ws')).toBe(false)
    expect(
      await call('sandbox:set-switches', sender(1), 'ws', { unixSockets: false, enabled: false }),
    ).toMatchObject({ switches: { unixSockets: false } })
    expect(store.get('ws').switches).toEqual({ unixSockets: false })
    await call('sandbox:set-switches', sender(1), 'ws', {})
    expect(store.get('ws').switches).toBeUndefined()
  })

  it('stores blocked domains after the same checks as allowed ones', async () => {
    const { store, call } = setup('denied')
    expect(await call('sandbox:set-denied-domains', sender(2), 'ws', ['ads.example.com'])).toEqual({
      ok: false,
      errors: [],
    })
    expect(await call('sandbox:set-denied-domains', sender(1), 'ws', ['*'])).toEqual({
      ok: false,
      errors: [{ value: '*', reason: 'wildcard-all' }],
    })
    expect(
      await call('sandbox:set-denied-domains', sender(1), 'ws', ['Ads.Example.com']),
    ).toMatchObject({ ok: true, settings: { deniedDomains: ['ads.example.com'] } })
    expect(store.get('ws').deniedDomains).toEqual(['ads.example.com'])
  })

  it('changes the restart stamp for a filesystem or socket edit, and not for a domain edit', async () => {
    const { call } = setup('stamp')
    await call('sandbox:set-enabled', sender(1), 'ws', true)
    const first = await call('sandbox:stamp', sender(1), 'ws')
    expect(first).toEqual(expect.any(String))
    expect(await call('sandbox:stamp', sender(2), 'ws')).toBeNull()
    await call('sandbox:set-domains', sender(1), 'ws', ['example.com'])
    await call('sandbox:set-denied-domains', sender(1), 'ws', ['ads.example.com'])
    await call('sandbox:set-switches', sender(1), 'ws', { strictDomains: true })
    expect(await call('sandbox:stamp', sender(1), 'ws')).toBe(first)
    await call('sandbox:set-paths', sender(1), 'ws', 'allowWrite', ['~/builds'])
    const second = await call('sandbox:stamp', sender(1), 'ws')
    expect(second).not.toBe(first)
    await call('sandbox:set-switches', sender(1), 'ws', { unixSockets: false })
    expect(await call('sandbox:stamp', sender(1), 'ws')).not.toBe(second)
  })
})

describe('sandbox violations IPC', () => {
  it('shows and clears violations only for the window that shows the workspace', async () => {
    const { violations, call } = setup('violations')
    violations.add('ws', parseViolationLine('deny openat /etc/hosts'))
    expect(await call('sandbox:violations', sender(2), 'ws')).toEqual([])
    expect(await call('sandbox:clear-violations', sender(2), 'ws')).toBe(false)
    expect(await call('sandbox:violations', sender(1), 'ws')).toMatchObject([
      { kind: 'write', target: '/etc/hosts', count: 1, last: 5 },
    ])
    expect(await call('sandbox:clear-violations', sender(1), 'ws')).toBe(true)
    expect(await call('sandbox:violations', sender(1), 'ws')).toEqual([])
  })
})

describe('sandbox folder check', () => {
  it('refuses to sandbox a workspace whose folder is the home folder, above it or holds Ostia data', async () => {
    const base = join(root, 'folders', 'home')
    const { store, call } = setup('folders', {
      atHome: base,
      tilde: '~',
      above: join(root, 'folders'),
      data: join(base, '.local'),
    })
    mkdirSync(join(base, '.local'), { recursive: true })
    expect(await call('sandbox:set-enabled', sender(1), 'atHome', true)).toEqual({
      ok: false,
      reason: 'folder',
      problem: { folder: base, reason: 'home' },
    })
    expect(await call('sandbox:set-enabled', sender(1), 'tilde', true)).toEqual({
      ok: false,
      reason: 'folder',
      problem: { folder: base, reason: 'home' },
    })
    expect(await call('sandbox:set-enabled', sender(1), 'above', true)).toMatchObject({
      reason: 'folder',
      problem: { reason: 'above-home' },
    })
    expect(await call('sandbox:set-enabled', sender(1), 'data', true)).toMatchObject({
      reason: 'folder',
      problem: { reason: 'ostia-data' },
    })
    expect(store.has('atHome')).toBe(false)
    expect(await call('sandbox:set-enabled', sender(1), 'ws', true)).toMatchObject({ ok: true })
  })

  it('reads a folder written with ~ as the path it stands for', async () => {
    const { home, workDir, sandboxes, call } = setup('tilde', { ws: '~/proj' })
    expect(sandboxes.workDir('ws')).toBe(workDir)
    expect(await call('sandbox:set-enabled', sender(1), 'ws', true)).toMatchObject({ ok: true })
    const { filesystem } = sandboxes.config('ws')
    expect(filesystem.allowWrite).toContain(workDir)
    expect(filesystem.allowWrite).not.toContain('~/proj')
    expect(filesystem.denyWrite).toContain(join(home, 'proj/.git/hooks'))
  })

  it('still turns the sandbox off for a workspace whose folder became the home folder', async () => {
    const dirs: Record<string, string> = {}
    const { home, store, call } = setup('later', dirs)
    await call('sandbox:set-enabled', sender(1), 'ws', true)
    dirs.ws = home
    expect(await call('sandbox:stamp', sender(1), 'ws')).toBeNull()
    expect(await call('sandbox:set-enabled', sender(1), 'ws', false)).toMatchObject({ ok: true })
    expect(store.get('ws').enabled).toBe(false)
  })
})
