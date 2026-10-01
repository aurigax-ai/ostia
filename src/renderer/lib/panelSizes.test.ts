import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLocalStorage } from '../../../test/mocks/memoryStorage'
import {
  PANEL_SIZES_KEY,
  PANEL_SIZES_WRITE_DELAY_MS,
  rememberPanelFractions,
  rememberedPanelFraction,
} from './panelSizes'

describe('panelSizes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installLocalStorage()
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
    window.localStorage.clear()
  })

  it('answers a fraction right away and writes it to storage once the drags settle', () => {
    rememberPanelFractions([{ key: 'extension:assistant', fraction: 0.3 }])
    rememberPanelFractions([{ key: 'extension:assistant', fraction: 0.35 }])

    expect(rememberedPanelFraction('extension:assistant')).toBe(0.35)
    expect(window.localStorage.getItem(PANEL_SIZES_KEY)).toBeNull()

    vi.advanceTimersByTime(PANEL_SIZES_WRITE_DELAY_MS)

    expect(JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}')).toEqual({
      'extension:assistant': 0.35,
    })
  })

  it('keeps fractions already stored for other panels', () => {
    window.localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify({ chat: 0.4 }))

    rememberPanelFractions([{ key: 'view:deploys', fraction: 0.2 }])
    vi.advanceTimersByTime(PANEL_SIZES_WRITE_DELAY_MS)

    expect(JSON.parse(window.localStorage.getItem(PANEL_SIZES_KEY) ?? '{}')).toEqual({
      chat: 0.4,
      'view:deploys': 0.2,
    })
  })

  it('reads a fraction another window stored', () => {
    window.localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify({ chat: 0.4 }))

    expect(rememberedPanelFraction('chat')).toBe(0.4)
    expect(rememberedPanelFraction('view:unknown')).toBeNull()
  })

  it('clamps or drops hand-edited values instead of trusting them', () => {
    window.localStorage.setItem(
      PANEL_SIZES_KEY,
      JSON.stringify({ chat: 2, 'view:a': 'wide', 'extension:git': 0.01 }),
    )

    expect(rememberedPanelFraction('chat')).toBe(0.85)
    expect(rememberedPanelFraction('view:a')).toBeNull()
    expect(rememberedPanelFraction('extension:git')).toBe(0.15)
  })

  it('treats unreadable storage as nothing remembered', () => {
    window.localStorage.setItem(PANEL_SIZES_KEY, '{not json')

    expect(rememberedPanelFraction('chat')).toBeNull()
  })
})
