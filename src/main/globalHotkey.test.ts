import { describe, expect, it, vi } from 'vitest'
import { GlobalHotkey, shouldHideWindows } from './globalHotkey'

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
