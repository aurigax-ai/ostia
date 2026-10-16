import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useFlipped } from './useFlipped'

describe('useFlipped', () => {
  it('reports nothing on the first render, so a launch or restore never animates', () => {
    const { result } = renderHook(() => useFlipped({ a: true, b: false }))
    expect([...result.current]).toEqual([])
  })

  it('reports a flag that changed value since the last change', () => {
    const { result, rerender } = renderHook(({ flags }) => useFlipped(flags), {
      initialProps: { flags: { a: false, b: true } },
    })
    rerender({ flags: { a: true, b: true } })
    expect([...result.current]).toEqual(['a'])
    rerender({ flags: { a: true, b: true } })
    expect([...result.current]).toEqual(['a'])
    rerender({ flags: { a: true, b: false } })
    expect([...result.current]).toEqual(['b'])
  })

  it('ignores a key that did not exist on the previous render', () => {
    const { result, rerender } = renderHook(({ flags }) => useFlipped(flags), {
      initialProps: { flags: { a: false } as Record<string, boolean> },
    })
    rerender({ flags: { a: false, fresh: true } })
    expect([...result.current]).toEqual([])
  })
})
