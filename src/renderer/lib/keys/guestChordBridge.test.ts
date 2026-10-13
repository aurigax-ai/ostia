import { commands } from '@/commands/registry'
import { createPane } from '@/layout/tree'
import { registerBrowserHandle } from '@/lib/browser/browserHandles'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { DOUBLE_SHIFT, DOUBLE_SHIFT_KEY } from '@shared/keyboard/chordSpec'
import { guestChordKey } from '@shared/keyboard/guestChords'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guestChordSignatures, handleGuestChord, syncGuestChords } from './guestChordBridge'

const initialSettings = useSettingsStore.getState()
const initialLayout = useLayoutStore.getState()
const initialWorkspaces = useWorkspacesStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useSettingsStore.setState(initialSettings, true)
  useLayoutStore.setState(initialLayout, true)
  useWorkspacesStore.setState(initialWorkspaces, true)
})

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>>,
) => ({
  key: k,
  code: /^[0-9]$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

function browserPane() {
  const term = createPane()
  const web = createPane()
  useLayoutStore.setState({
    byWorkspace: {
      s1: {
        root: {
          type: 'split',
          id: 'sp',
          direction: 'horizontal',
          children: [term, web],
          sizes: [1, 1],
        },
        activePaneId: term.id,
        zoomedPaneId: null,
      },
    },
  })
  const handle = {
    guestId: () => 7,
    focusAddress: vi.fn(),
    reload: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    find: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  }
  const off = registerBrowserHandle(web.id, handle)
  return { term, web, handle, off }
}

describe('guestChordSignatures', () => {
  it('lists app, browser and find chords, but not the clipboard, block or terminal-only keys', () => {
    const sigs = guestChordSignatures(false)
    expect(sigs).toEqual(
      expect.arrayContaining([
        'Ctrl+Shift+P',
        'Ctrl+Shift+F',
        'Ctrl+Shift+L',
        'Ctrl+F5',
        'Ctrl+1-9',
      ]),
    )
    expect(sigs).not.toContain('Ctrl+Shift+C')
    expect(sigs).not.toContain('Ctrl+Shift+V')
    expect(sigs).not.toContain('Ctrl+Shift+Up')
    expect(sigs).not.toContain('Ctrl+Shift+K')
    expect(sigs).not.toContain('Ctrl+Shift+Enter')
    expect(sigs).toContain(DOUBLE_SHIFT)
  })

  it('forwards ⌘G and ⇧⌘G so a page’s find bar steps on macOS', () => {
    expect(guestChordSignatures(true)).toEqual(
      expect.arrayContaining(['Cmd+G', 'Shift+Cmd+G', 'Shift+Cmd+F']),
    )
  })

  it('sends the list to main now and after a rebind', () => {
    const stop = syncGuestChords(false)
    expect(window.ostia.guestChords.set).toHaveBeenLastCalledWith(
      expect.arrayContaining(['Ctrl+Shift+P']),
    )
    useSettingsStore.setState({ keybindings: { 'palette.toggle': 'Ctrl+Alt+P' } })
    const last = vi.mocked(window.ostia.guestChords.set).mock.lastCall?.[0] ?? []
    expect(last).toContain('Ctrl+Alt+P')
    expect(last).not.toContain('Ctrl+Shift+P')
    stop()
  })
})

describe('handleGuestChord', () => {
  it('runs an app chord pressed inside a page, with the workspace digit', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    expect(
      handleGuestChord({ guestId: 99, key: key('p', { ctrlKey: true, shiftKey: true }) }, false),
    ).toBe(true)
    expect(exec).toHaveBeenCalledWith('palette.toggle')
    handleGuestChord({ guestId: 99, key: key('3', { ctrlKey: true }) }, false)
    expect(exec).toHaveBeenLastCalledWith('workspace.goto', { index: 2 })
  })

  it('focuses the browser pane of the guest and runs browser keys on it', () => {
    const { web, handle, off } = browserPane()
    try {
      expect(
        handleGuestChord({ guestId: 7, key: key('l', { ctrlKey: true, shiftKey: true }) }, false),
      ).toBe(true)
      expect(handle.focusAddress).toHaveBeenCalled()
      expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(web.id)
      handleGuestChord({ guestId: 7, key: key('f', { ctrlKey: true, shiftKey: true }) }, false)
      expect(handle.find).toHaveBeenCalled()
    } finally {
      off()
    }
  })

  it('on Linux, Ctrl+L and Ctrl+R drive a browser pane', () => {
    const { handle, off } = browserPane()
    const sigs = new Set(guestChordSignatures(false))
    const press = (k: string) =>
      guestChordKey(
        {
          type: 'keyDown',
          key: k,
          code: `Key${k.toUpperCase()}`,
          control: true,
          shift: false,
          alt: false,
          meta: false,
        },
        sigs,
        false,
      )
    try {
      const reload = press('r')
      expect(reload).not.toBeNull()
      expect(handleGuestChord({ guestId: 7, key: reload }, false)).toBe(true)
      expect(handle.reload).toHaveBeenCalledTimes(1)
      const address = press('l')
      expect(address).not.toBeNull()
      expect(handleGuestChord({ guestId: 7, key: address }, false)).toBe(true)
      expect(handle.focusAddress).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('runs what Shift twice is bound to after focusing the pane the taps came from', () => {
    const { web, off } = browserPane()
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    try {
      expect(handleGuestChord({ guestId: 7, key: DOUBLE_SHIFT_KEY }, false)).toBe(true)
      expect(exec).toHaveBeenCalledWith('palette.searchEverywhere')
      expect(useLayoutStore.getState().byWorkspace.s1.activePaneId).toBe(web.id)
      useSettingsStore.setState({ keybindings: { 'palette.searchEverywhere': null } })
      expect(handleGuestChord({ guestId: 7, key: DOUBLE_SHIFT_KEY }, false)).toBe(false)
      expect(exec).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('ignores browser keys from an unknown guest and anything malformed', () => {
    const exec = vi.spyOn(commands, 'exec')
    expect(
      handleGuestChord({ guestId: 5, key: key('l', { ctrlKey: true, shiftKey: true }) }, false),
    ).toBe(false)
    expect(handleGuestChord({ guestId: 5 }, false)).toBe(false)
    expect(
      handleGuestChord({ guestId: 5, key: key('y', { ctrlKey: true, shiftKey: true }) }, false),
    ).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})
