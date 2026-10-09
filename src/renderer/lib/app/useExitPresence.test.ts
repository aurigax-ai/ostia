import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useExitPresence } from './useExitPresence'

describe('useExitPresence', () => {
  it('keeps the last value while leaving and drops it once the exit finishes', () => {
    const { result, rerender } = renderHook(({ v }) => useExitPresence(v), {
      initialProps: { v: 'a' as string | null },
    })
    expect(result.current).toMatchObject({ shown: 'a', leaving: false })

    rerender({ v: null })
    expect(result.current).toMatchObject({ shown: 'a', leaving: true })

    act(() => result.current.onExited())
    expect(result.current).toMatchObject({ shown: null, leaving: false })
  })

  it('cancels the exit when a value comes back before it finishes', () => {
    const { result, rerender } = renderHook(({ v }) => useExitPresence(v), {
      initialProps: { v: 'a' as string | null },
    })
    rerender({ v: null })
    rerender({ v: 'b' })
    expect(result.current).toMatchObject({ shown: 'b', leaving: false })
  })

  it('shows nothing when it never had a value', () => {
    const { result } = renderHook(() => useExitPresence<string>(null))
    expect(result.current).toMatchObject({ shown: null, leaving: false })
  })
})
