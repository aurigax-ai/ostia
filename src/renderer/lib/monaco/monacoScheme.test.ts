import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_COLOR_SCHEMES } from '@/lib/colorSchemes/builtinColorSchemes'
import { monacoThemeId } from './monacoTheme'

const fake = vi.hoisted(() => ({
  monaco: { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } },
}))

vi.mock('./setup', () => ({ monaco: fake.monaco }))

async function freshTheme(): Promise<typeof import('./monacoScheme')> {
  vi.resetModules()
  return import('./monacoScheme')
}

describe('Monaco scheme', () => {
  beforeEach(() => {
    fake.monaco.editor.defineTheme.mockClear()
    fake.monaco.editor.setTheme.mockClear()
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
