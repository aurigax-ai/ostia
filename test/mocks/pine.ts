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
      onMaximizeChange: vi.fn(noopUnsub),
    },
    pty: {
      attach: vi.fn().mockResolvedValue({ created: true, buffer: '', cursor: 0, dropped: false }),
      detach: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn(noopUnsub),
      onExit: vi.fn(noopUnsub),
    },
    fs: {
      list: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(true),
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
    },
    session: {
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
    },
    kanban: {
      get: vi.fn().mockResolvedValue({ columns: [], cards: [] }),
      mutate: vi.fn().mockResolvedValue({ ok: true, board: { columns: [], cards: [] } }),
    },
    wiki: {
      list: vi.fn().mockResolvedValue({ pages: [] }),
      get: vi.fn().mockResolvedValue({ ok: false, error: 'not-found' }),
      set: vi.fn().mockResolvedValue({ ok: true }),
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
      status: vi
        .fn()
        .mockResolvedValue({
          running: false,
          host: null,
          port: null,
          fingerprint: null,
          deviceCount: 0,
        }),
      devices: vi.fn().mockResolvedValue({ devices: [] }),
      revoke: vi.fn().mockResolvedValue({ ok: true }),
      setCap: vi.fn().mockResolvedValue({ ok: true, caps: ['read', 'board.read', 'notify'] }),
      bindOptions: vi.fn().mockResolvedValue({
        addresses: [{ address: '127.0.0.1', kind: 'loopback' }],
        selected: '127.0.0.1',
      }),
    },
  }
  return { ...base, ...overrides }
}
