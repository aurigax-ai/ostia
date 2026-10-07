import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_COLOR_SCHEMES } from '../plugins/colorSchemes'
import { monacoThemeId } from './monacoTheme'

const fake = vi.hoisted(() => ({
  monaco: { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } },
}))

vi.mock('./setup', () => ({ monaco: fake.monaco }))

async function freshTheme(): Promise<typeof import('./useMonacoTheme')> {
  vi.resetModules()
  return import('./useMonacoTheme')
}

describe('Monaco theme', () => {
  beforeEach(() => {
    fake.monaco.editor.defineTheme.mockClear()
    fake.monaco.editor.setTheme.mockClear()
  })

  it('sets the editor scheme before the first editor and only once for many editors', async () => {
    const { ensureMonacoTheme } = await freshTheme()
    ensureMonacoTheme()
    ensureMonacoTheme()
    expect(fake.monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
    expect(fake.monaco.editor.setTheme).toHaveBeenCalledTimes(1)
  })

  it('does not define the theme again when the app applies the same scheme', async () => {
    const { ensureMonacoTheme, useMonacoTheme } = await freshTheme()
    ensureMonacoTheme()
    const { unmount } = renderHook(() => useMonacoTheme())
    expect(fake.monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('defines the theme once per scheme change', async () => {
    const { applyMonacoScheme } = await freshTheme()
    const [first, second] = BUILTIN_COLOR_SCHEMES
    applyMonacoScheme(first)
    applyMonacoScheme(first)
    applyMonacoScheme(second)
    expect(fake.monaco.editor.defineTheme).toHaveBeenCalledTimes(2)
    expect(fake.monaco.editor.setTheme).toHaveBeenLastCalledWith(monacoThemeId(second))
  })
})
