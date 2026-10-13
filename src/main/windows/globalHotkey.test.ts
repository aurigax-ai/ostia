import { describe, expect, it, vi } from 'vitest'
import { GlobalHotkey, shouldHideWindows, toggleWindows } from './globalHotkey'

function registry(taken: readonly string[] = []) {
  const live = new Map<string, () => void>()
  return {
    live,
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (taken.includes(accelerator)) return false
      live.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      live.delete(accelerator)
    }),
  }
}

describe('GlobalHotkey', () => {
  it('registers the chosen chord as an accelerator and runs the toggle on it', () => {
    const reg = registry()
    const toggle = vi.fn()
    const hotkey = new GlobalHotkey(reg, toggle)
    expect(hotkey.apply('ctrl+alt+space')).toBe('registered')
    expect([...reg.live.keys()]).toEqual(['Ctrl+Alt+Space'])
    reg.live.get('Ctrl+Alt+Space')?.()
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('swaps the old chord for a new one, keeps one it already holds, and clears on empty', () => {
    const reg = registry()
    const hotkey = new GlobalHotkey(reg, () => undefined)
    hotkey.apply('Ctrl+Alt+P')
    hotkey.apply('Ctrl+Alt+P')
    expect(reg.register).toHaveBeenCalledTimes(1)
    hotkey.apply('Super+F12')
    expect([...reg.live.keys()]).toEqual(['Super+F12'])
    expect(hotkey.apply('')).toBe('off')
    expect(reg.live.size).toBe(0)
  })

  it('refuses a key without a modifier or with Shift alone, and reports a chord in use', () => {
    const reg = registry(['Ctrl+Alt+T'])
    const hotkey = new GlobalHotkey(reg, () => undefined)
    expect(hotkey.apply('F1')).toBe('off')
    expect(hotkey.apply('Shift+A')).toBe('off')
    expect(hotkey.apply('Ctrl+Bogus')).toBe('off')
    expect(hotkey.apply(42)).toBe('off')
    expect(hotkey.apply('Ctrl+Alt+T')).toBe('taken')
    expect(reg.register).toHaveBeenCalledTimes(1)
  })

  it('workspaces.globalHotkey registers a system-wide shortcut and drops it when cleared', () => {
    const reg = registry()
    const hotkey = new GlobalHotkey(reg, () => undefined)
    expect(hotkey.apply('Ctrl+Alt+F9')).toBe('registered')
    expect(reg.register).toHaveBeenCalledWith('Ctrl+Alt+F9', expect.any(Function))
    expect([...reg.live.keys()]).toEqual(['Ctrl+Alt+F9'])
    expect(hotkey.apply('')).toBe('off')
    expect(reg.unregister).toHaveBeenCalledWith('Ctrl+Alt+F9')
    expect(reg.live.size).toBe(0)
  })
})

describe('shouldHideWindows', () => {
  const win = (visible: boolean, focused: boolean) => ({
    isVisible: () => visible,
    isFocused: () => focused,
    isDestroyed: () => false,
  })

  it('hides only when a visible window has focus; otherwise the hotkey brings them up', () => {
    expect(shouldHideWindows([win(true, true), win(true, false)])).toBe(true)
    expect(shouldHideWindows([win(true, false)])).toBe(false)
    expect(shouldHideWindows([win(false, false)])).toBe(false)
    expect(shouldHideWindows([])).toBe(false)
  })
})

describe('toggleWindows', () => {
  function windows(count: number) {
    return Array.from({ length: count }, () => ({
      shown: true,
      isVisible() {
        return this.shown
      },
      isFocused() {
        return this.shown
      },
      isDestroyed: () => false,
    }))
  }

  it('hides the focused windows to the tray, then reveals them, then hides them again', () => {
    const list = windows(2)
    const tray = {
      hide: vi.fn((win: { shown: boolean }) => {
        win.shown = false
      }),
    }
    const reveal = vi.fn(() => {
      for (const win of list) win.shown = true
    })
    toggleWindows(list, tray, reveal)
    expect(tray.hide).toHaveBeenCalledTimes(2)
    expect(list.map((w) => w.shown)).toEqual([false, false])
    toggleWindows(list, tray, reveal)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(list.map((w) => w.shown)).toEqual([true, true])
    toggleWindows(list, tray, reveal)
    expect(tray.hide).toHaveBeenCalledTimes(4)
  })

  it('reveals when there is no tray or no window is focused', () => {
    const reveal = vi.fn()
    const hide = vi.fn()
    toggleWindows(windows(1), null, reveal)
    const unfocused = windows(1)
    unfocused[0].shown = false
    toggleWindows(unfocused, { hide }, reveal)
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(hide).not.toHaveBeenCalled()
  })
})
