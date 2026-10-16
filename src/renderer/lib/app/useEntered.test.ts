import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useEntered } from './useEntered'

describe('useEntered', () => {
  it('reports nothing on the first render, so a launch or restore never animates', () => {
    const { result } = renderHook(() => useEntered(['a', 'b']))
    expect([...result.current]).toEqual([])
  })

  it('reports the keys that appeared since the last change', () => {
    const { result, rerender } = renderHook(({ keys }) => useEntered(keys), {
      initialProps: { keys: ['a'] },
    })
    rerender({ keys: ['a', 'b'] })
    expect([...result.current]).toEqual(['b'])
    rerender({ keys: ['a', 'b'] })
    expect([...result.current]).toEqual(['b'])
    rerender({ keys: ['b'] })
    expect([...result.current]).toEqual([])
  })
})
