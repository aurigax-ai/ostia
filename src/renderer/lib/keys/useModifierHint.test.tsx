import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODIFIER_HINT_DELAY_MS, useModifierHint } from './useModifierHint'

const press = (type: 'keydown' | 'keyup', key: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { key }))
const shown = () => useUIStore.getState().digitHints

describe('useModifierHint', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    useUIStore.setState({ digitHints: false })
    useSettingsStore.setState({ keybindings: {} })
  })

  it('shows workspace digits after Ctrl is held alone, and hides them on release', () => {
    renderHook(() => useModifierHint(false))
    press('keydown', 'Control')
    expect(shown()).toBe(false)
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS)
    expect(shown()).toBe(true)
    press('keyup', 'Control')
    expect(shown()).toBe(false)
  })

  it('never flashes digits for a Ctrl shortcut like Ctrl+C', () => {
    renderHook(() => useModifierHint(false))
    press('keydown', 'Control')
    press('keydown', 'c')
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS * 2)
    expect(shown()).toBe(false)
  })

  it('uses Cmd on macOS', () => {
    renderHook(() => useModifierHint(true))
    press('keydown', 'Control')
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS)
    expect(shown()).toBe(false)
    press('keydown', 'Meta')
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS)
    expect(shown()).toBe(true)
  })

  it('follows a rebound workspace jump: only its exact modifiers show the digits', () => {
    useSettingsStore.setState({ keybindings: { 'workspace.goto': 'Ctrl+Alt+1-9' } })
    renderHook(() => useModifierHint(false))
    press('keydown', 'Control')
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS)
    expect(shown()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', ctrlKey: true, altKey: true }))
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS)
    expect(shown()).toBe(true)
  })

  it('never shows digits once the workspace jump is unbound', () => {
    useSettingsStore.setState({ keybindings: { 'workspace.goto': null } })
    renderHook(() => useModifierHint(false))
    press('keydown', 'Control')
    vi.advanceTimersByTime(MODIFIER_HINT_DELAY_MS * 2)
    expect(shown()).toBe(false)
  })
})
