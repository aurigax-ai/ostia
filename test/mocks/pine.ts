import type { PineBridge } from '@shared/types'
import { vi } from 'vitest'

export function makePineMock(overrides?: Partial<PineBridge>): PineBridge {
  const noopUnsub = () => () => {}
  const base: PineBridge = {
    ping: vi.fn().mockResolvedValue('pong'),
    info: vi.fn().mockResolvedValue({ name: 'pine', version: '0.0.0', platform: 'linux' }),
    platform: 'linux',
    window: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn().mockResolvedValue(false),
      setZoom: vi.fn().mockImplementation((percent: number) => Promise.resolve(percent)),
      isSystemDark: vi.fn().mockResolvedValue(true),
      onSystemDarkChange: vi.fn(noopUnsub),
      onMaximizeChange: vi.fn(noopUnsub),
      onConfirmClose: vi.fn(noopUnsub),
    },
    pty: {
      attach: vi.fn().mockResolvedValue({ created: true, buffer: '', cursor: 0, dropped: false }),
      detach: vi.fn(),
      hibernate: vi.fn().mockResolvedValue(true),
      restart: vi.fn().mockResolvedValue(true),
      write: vi.fn(),
      resize: vi.fn(),
      commands: vi.fn().mockResolvedValue([]),
      promptContext: vi.fn().mockResolvedValue(null),
      onData: vi.fn(noopUnsub),
      onExit: vi.fn(noopUnsub),
    },
    fs: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(true),
      stat: vi.fn().mockResolvedValue(null),
      readBinary: vi.fn().mockResolvedValue({ ok: false, error: 'unreadable' }),
    },
    lsp: {
      list: vi.fn().mockResolvedValue([]),
      start: vi.fn().mockResolvedValue(null),
      send: vi.fn(),
      stop: vi.fn(),
      onMessage: vi.fn(noopUnsub),
      onExit: vi.fn(noopUnsub),
    },
    settings: {
      path: vi.fn().mockResolvedValue('/tmp/pine-test/settings.json'),
      onChanged: vi.fn(noopUnsub),
    },
    sync: {
      status: vi
        .fn()
        .mockResolvedValue({ dir: null, state: 'off', lastSync: null, lastConflict: null }),
      run: vi
        .fn()
        .mockResolvedValue({ dir: null, state: 'off', lastSync: null, lastConflict: null }),
      pickFolder: vi.fn().mockResolvedValue(null),
      onStatus: vi.fn(noopUnsub),
    },
    workspace: {
      save: vi.fn(),
      load: vi.fn().mockResolvedValue(null),
    },
    lifecycle: {
      emit: vi.fn(),
    },
    commands: {
      publish: vi.fn(),
      onInvoke: vi.fn(noopUnsub),
    },
    terminalState: {
      push: vi.fn(),
    },
    browser: {
      register: vi.fn(),
      unregister: vi.fn(),
      pickStart: vi.fn().mockResolvedValue({ ok: false, error: 'cancelled' }),
      pickCancel: vi.fn(),
      pickSend: vi.fn().mockResolvedValue({ ok: false, error: 'not-found' }),
      onPickState: vi.fn(noopUnsub),
      storageRead: vi.fn().mockResolvedValue({ ok: false, error: 'browser-not-ready' }),
      storageSet: vi.fn().mockResolvedValue({ ok: true }),
      storageRemove: vi.fn().mockResolvedValue({ ok: true }),
      storageClear: vi.fn().mockResolvedValue({ ok: true }),
    },
    selection: {
      send: vi.fn().mockResolvedValue({ ok: false, error: 'not-found' }),
    },
    agentSession: {
      info: vi.fn().mockResolvedValue(null),
    },
    update: {
      state: vi.fn().mockResolvedValue(null),
      restart: vi.fn().mockResolvedValue(undefined),
      onAvailable: vi.fn(() => () => {}),
    },
    system: {
      requirements: vi.fn().mockResolvedValue(null),
      installRequirements: vi.fn().mockResolvedValue({ ok: true }),
    },
    secrets: {
      view: vi.fn().mockResolvedValue(null),
      setGrants: vi.fn().mockResolvedValue({ ok: false, errors: [] }),
      vaultSet: vi.fn().mockResolvedValue(true),
      vaultDelete: vi.fn().mockResolvedValue(true),
    },
    sandbox: {
      onBlocked: vi.fn(() => () => {}),
      get: vi.fn().mockResolvedValue(null),
      setEnabled: vi.fn().mockResolvedValue(null),
      setAllowRead: vi.fn().mockResolvedValue({ ok: false, errors: [] }),
      setDomains: vi.fn().mockResolvedValue({ ok: false, errors: [] }),
      setControls: vi.fn().mockResolvedValue(null),
      refusals: vi.fn().mockResolvedValue([]),
      allowRefused: vi.fn().mockResolvedValue(true),
      globalsChanged: vi.fn().mockResolvedValue(true),
      ports: vi.fn().mockResolvedValue([]),
      expose: vi.fn().mockResolvedValue({ ok: true, port: 3000 }),
      unexpose: vi.fn().mockResolvedValue(true),
      setPortsPolicy: vi.fn().mockResolvedValue(null),
    },
    credentials: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue({ ok: true, id: 'c1', updated: false }),
      remove: vi.fn().mockResolvedValue(true),
      copyPassword: vi.fn().mockResolvedValue(true),
      import: vi.fn().mockResolvedValue({ ok: false, error: 'cancelled' }),
    },
    approvals: {
      state: vi.fn().mockResolvedValue({ pending: [], history: [] }),
      answer: vi.fn().mockResolvedValue(true),
      revoke: vi.fn().mockResolvedValue(true),
      onChange: vi.fn(() => () => {}),
    },
    extensions: {
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockResolvedValue([]),
      approve: vi.fn().mockResolvedValue([]),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
      panel: vi.fn().mockResolvedValue({ ok: false, error: 'no-panel' }),
      sidebarItems: vi.fn().mockResolvedValue([]),
      paneChips: vi.fn().mockResolvedValue([]),
      setSetting: vi.fn().mockResolvedValue({ ok: false, error: 'unknown-extension' }),
      onChanged: vi.fn(noopUnsub),
      onSidebar: vi.fn(noopUnsub),
      onPaneChips: vi.fn(noopUnsub),
      onOpenPanel: vi.fn(noopUnsub),
      onOpenDiff: vi.fn(noopUnsub),
      onOpenTerminal: vi.fn(noopUnsub),
    },
    externalEditor: {
      open: vi.fn().mockResolvedValue({ ok: true, argv: [] }),
    },
    gateway: {
      enable: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 8722, fingerprint: 'sha256/x' }),
      disable: vi.fn().mockResolvedValue({ ok: true }),
      pair: vi.fn().mockResolvedValue({
        v: 1,
        host: '127.0.0.1',
        port: 8722,
        fingerprint: 'sha256/x',
        pairCode: 'ABCD1234',
        name: 'test-host',
      }),
      status: vi.fn().mockResolvedValue({
        running: false,
        host: null,
        port: null,
        fingerprint: null,
        deviceCount: 0,
      }),
      devices: vi.fn().mockResolvedValue({ devices: [] }),
      revoke: vi.fn().mockResolvedValue({ ok: true }),
      setCap: vi.fn().mockResolvedValue({ ok: true, caps: ['read', 'notify'] }),
      bindOptions: vi.fn().mockResolvedValue({
        addresses: [{ address: '127.0.0.1', kind: 'loopback' }],
        selected: '127.0.0.1',
      }),
    },
    notifications: {
      list: vi.fn().mockResolvedValue([]),
      post: vi.fn(),
      clear: vi.fn(),
      onChanged: vi.fn(noopUnsub),
      onActivate: vi.fn(noopUnsub),
    },
    workflows: {
      list: vi.fn().mockResolvedValue({ workflows: [], problems: [] }),
      save: vi.fn().mockResolvedValue({ ok: true, file: 'workflow.yaml' }),
    },
    completions: {
      spec: vi.fn().mockResolvedValue(null),
    },
  }
  return { ...base, ...overrides }
}
