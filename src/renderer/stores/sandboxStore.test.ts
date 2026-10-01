import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { needsSandboxRestart, useSandboxStore } from './sandboxStore'

let init: ReturnType<typeof useSandboxStore.getState>

beforeAll(() => {
  init = useSandboxStore.getState()
})

afterEach(() => {
  useSandboxStore.setState(init, true)
})

describe('needsSandboxRestart', () => {
  it('asks for a restart when the pane and the workspace disagree about being sandboxed', () => {
    const state = { enabled: { ws: true }, paneSandboxed: { p: false } }
    expect(needsSandboxRestart(state, 'ws', 'p')).toBe(true)
    expect(needsSandboxRestart({ ...state, paneSandboxed: { p: true } }, 'ws', 'p')).toBe(false)
  })

  it('asks for a restart when a sandboxed pane was started under an older file or socket policy', () => {
    const state = {
      enabled: { ws: true },
      paneSandboxed: { p: true },
      stamp: { ws: 'new' },
      paneStamp: { p: 'old' },
    }
    expect(needsSandboxRestart(state, 'ws', 'p')).toBe(true)
    expect(needsSandboxRestart({ ...state, paneStamp: { p: 'new' } }, 'ws', 'p')).toBe(false)
  })

  it('never asks for an unsandboxed pane, a host pane or while a stamp is unknown', () => {
    const stale = { stamp: { ws: 'new' }, paneStamp: { p: 'old' } }
    expect(
      needsSandboxRestart(
        { enabled: { ws: false }, paneSandboxed: { p: false }, ...stale },
        'ws',
        'p',
      ),
    ).toBe(false)
    expect(
      needsSandboxRestart(
        { enabled: { ws: true }, paneSandboxed: { p: true }, hostPanes: { p: true }, ...stale },
        'ws',
        'p',
      ),
    ).toBe(false)
    expect(
      needsSandboxRestart(
        { enabled: { ws: true }, paneSandboxed: { p: true }, stamp: { ws: null }, paneStamp: {} },
        'ws',
        'p',
      ),
    ).toBe(false)
  })
})

describe('sandboxStore', () => {
  it('reads the workspace stamp with its settings and compares it with the stamp a pane spawned under', async () => {
    vi.mocked(window.pine.sandbox.get).mockResolvedValue({
      enabled: true,
      allowRead: [],
      domains: [],
      controls: {},
    })
    vi.mocked(window.pine.sandbox.stamp).mockResolvedValue('s1')
    await useSandboxStore.getState().load('ws')
    useSandboxStore.getState().notePane('p', true, 's1')
    expect(needsSandboxRestart(useSandboxStore.getState(), 'ws', 'p')).toBe(false)
    vi.mocked(window.pine.sandbox.stamp).mockResolvedValue('s2')
    await useSandboxStore.getState().reloadAll()
    expect(needsSandboxRestart(useSandboxStore.getState(), 'ws', 'p')).toBe(true)
  })

  it('forgets the pane stamp on restart, so the button goes until the new shell reports its own', async () => {
    useSandboxStore.setState({
      enabled: { ws: true },
      stamp: { ws: 's2' },
      paneSandboxed: { p: true },
      paneStamp: { p: 's1' },
    })
    vi.mocked(window.pine.pty.restart).mockResolvedValue(true)
    await useSandboxStore.getState().restart('p')
    expect(useSandboxStore.getState().paneStamp.p).toBeUndefined()
    expect(needsSandboxRestart(useSandboxStore.getState(), 'ws', 'p')).toBe(false)
  })

  it('shows the missing-software dialog only when main says programs are missing', async () => {
    vi.mocked(window.pine.sandbox.setEnabled).mockResolvedValue({ ok: false, reason: 'not-owned' })
    await useSandboxStore.getState().setEnabled('ws', true)
    expect(window.pine.system.requirements).not.toHaveBeenCalled()
    expect(useSandboxStore.getState().blocked).toBeNull()
    expect(useSandboxStore.getState().refusedFolder).toBeNull()
  })
})
