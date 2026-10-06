import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { registerBrowserHandle } from './browserHandles'
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
