import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { useSettingsStore } from '../stores/settingsStore'
import { guestChordSignatures, handleGuestChord, syncGuestChords } from './guestChordBridge'

const initialSettings = useSettingsStore.getState()

afterEach(() => {
  vi.restoreAllMocks()
  useSettingsStore.setState(initialSettings, true)
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

describe('guestChordSignatures', () => {
  it('lists app chords, but not the clipboard, find or block keys', () => {
    const sigs = guestChordSignatures(false)
    expect(sigs).toEqual(expect.arrayContaining(['Ctrl+Shift+P', 'Ctrl+Shift+T', 'Ctrl+1-9']))
    expect(sigs).not.toContain('Ctrl+Shift+F')
    expect(sigs).not.toContain('Ctrl+Shift+C')
    expect(sigs).not.toContain('Ctrl+Shift+V')
    expect(sigs).not.toContain('Ctrl+Shift+Up')
  })

  it('sends the list to main now and after a rebind', () => {
    const stop = syncGuestChords(false)
    expect(window.pine.guestChords.set).toHaveBeenLastCalledWith(
      expect.arrayContaining(['Ctrl+Shift+P']),
    )
    useSettingsStore.setState({ keybindings: { 'palette.toggle': 'Ctrl+Alt+P' } })
    const last = vi.mocked(window.pine.guestChords.set).mock.lastCall?.[0] ?? []
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

  it('ignores unbound keys and anything malformed', () => {
    const exec = vi.spyOn(commands, 'exec')
    expect(handleGuestChord({ guestId: 5 }, false)).toBe(false)
    expect(
      handleGuestChord({ guestId: 5, key: key('q', { ctrlKey: true, shiftKey: true }) }, false),
    ).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})
