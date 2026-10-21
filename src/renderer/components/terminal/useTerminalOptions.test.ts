import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { currentScheme } from '@/lib/theme/colorScheme'
import { initialTerminalOptions, useTerminalOptions } from './useTerminalOptions'

describe('useTerminalOptions', () => {
  it('starts every engine with scrollback animation off', () => {
    expect(initialTerminalOptions().smoothScrollDuration).toBe(0)
  })

  it('paints an open terminal with the colors of a new scheme', () => {
    const term = { options: { ...initialTerminalOptions() } } as unknown as OstiaTerminal
    const font = {
      ...initialTerminalOptions(),
      family: 'monospace',
      size: 13,
      weight: 400,
      lineHeight: 1,
    }
    const colors = currentScheme('terminal').colors
    const props = (background: string) => ({
      termRef: { current: term },
      syncSizeRef: { current: vi.fn() },
      font: { family: font.family, size: font.size, weight: font.weight, lineHeight: 1 },
      palette: { ...colors, background },
    })
    const { rerender } = renderHook((p) => useTerminalOptions(p), {
      initialProps: props('#112233'),
    })
    expect(term.options.theme?.background).toBe('#112233')
    rerender(props('#fdf6e3'))
    expect(term.options.theme?.background).toBe('#fdf6e3')
  })
})
