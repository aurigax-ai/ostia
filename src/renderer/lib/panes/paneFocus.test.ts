import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useGuestReady } from './paneFocus'

function webview(guestReached: boolean): HTMLElement {
  const el = document.createElement('webview')
  Object.defineProperty(el, 'getWebContentsId', {
    value: () => {
      if (!guestReached) throw new Error('The WebView must be attached to the DOM')
      return 7
    },
  })
  return el
}

describe('useGuestReady', () => {
  it('waits for dom-ready when the guest has not reached it yet', () => {
    const el = webview(false)
    const { result } = renderHook(() => useGuestReady(el))
    expect(result.current).toBeNull()
    act(() => {
      el.dispatchEvent(new Event('dom-ready'))
    })
    expect(result.current).toBe(el)
  })

  it('takes a guest whose dom-ready fired before the hook listened', () => {
    const el = webview(true)
    const { result } = renderHook(() => useGuestReady(el))
    expect(result.current).toBe(el)
  })
})
