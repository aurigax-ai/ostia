import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loader = vi.hoisted(() => ({ loadedMonaco: vi.fn() }))

vi.mock('./monacoLoader', () => loader)

const { useMonacoTheme } = await import('./useMonacoTheme')

describe('useMonacoTheme', () => {
  beforeEach(() => {
    loader.loadedMonaco.mockReset()
  })

  it('does nothing before Monaco has loaded, because loading applies the current scheme', () => {
    loader.loadedMonaco.mockReturnValue(null)
    expect(() => renderHook(() => useMonacoTheme())).not.toThrow()
  })

  it('applies the editor scheme to a loaded Monaco', () => {
    const applyMonacoScheme = vi.fn()
    loader.loadedMonaco.mockReturnValue({ applyMonacoScheme })
    renderHook(() => useMonacoTheme())
    expect(applyMonacoScheme).toHaveBeenCalledOnce()
  })
})
