import { useSettingsStore } from '@/stores/app/settingsStore'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PLUGINS } from '../../plugins/builtin'
import type { ColorScheme } from '../../plugins/types'
import { CodeBlockContent } from './code-block'

const colorizeCode = vi.fn(async () => null)
vi.mock('@/lib/theme/colorize', () => ({
  colorizeCode: (...args: unknown[]) => colorizeCode(...(args as [])),
}))

const schemes = BUILTIN_PLUGINS.flatMap((p) => p.contributes.colorSchemes ?? [])
const scheme = (id: string): ColorScheme => schemes.find((s) => s.id === id) as ColorScheme

describe('CodeBlockContent', () => {
  const settingsInit = useSettingsStore.getState()

  afterEach(() => {
    cleanup()
    useSettingsStore.setState(settingsInit, true)
    colorizeCode.mockClear()
  })

  it('paints and colorizes the code in the editor color scheme, and follows a scheme change', async () => {
    useSettingsStore.setState((s) => ({ editor: { ...s.editor, theme: 'gruvbox-dark' } }))
    await act(async () => {
      render(<CodeBlockContent code="echo hi" language="bash" />)
    })
    const pre = screen.getByText('echo hi').closest('pre') as HTMLElement
    const dark = scheme('gruvbox-dark')
    expect(pre.style.background).toBe(hexToRgb(dark.colors.background))
    expect(pre.style.color).toBe(hexToRgb(dark.colors.foreground))
    expect(colorizeCode).toHaveBeenLastCalledWith('echo hi', 'bash', dark)

    await act(async () => {
      useSettingsStore.setState((s) => ({ editor: { ...s.editor, theme: 'gruvbox-light' } }))
    })
    const light = scheme('gruvbox-light')
    expect(pre.style.background).toBe(hexToRgb(light.colors.background))
    expect(colorizeCode).toHaveBeenLastCalledWith('echo hi', 'bash', light)
  })
})

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
