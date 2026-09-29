import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../stores/uiStore'
import { MODIFIER_HINT_DELAY_MS, useModifierHint } from './useModifierHint'

const press = (type: 'keydown' | 'keyup', key: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { key }))
const shown = () => useUIStore.getState().digitHints

describe('useModifierHint', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    useUIStore.setState({ digitHints: false })
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
})
