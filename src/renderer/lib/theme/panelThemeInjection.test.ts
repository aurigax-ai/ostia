import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useInjectedCss } from './panelThemeInjection'

function webview(guestReached: boolean) {
  const el = document.createElement('webview')
  const insertCSS = vi.fn(async () => 'key')
  Object.assign(el, { insertCSS, removeInsertedCSS: vi.fn(async () => undefined) })
  Object.defineProperty(el, 'getWebContentsId', {
    value: () => {
      if (!guestReached) throw new Error('The WebView must be attached to the DOM')
      return 7
    },
  })
  return { el, insertCSS }
}

describe('useInjectedCss', () => {
  it('injects again when dom-ready fires after the hook listens', () => {
    const { el, insertCSS } = webview(false)
    renderHook(() => useInjectedCss(el, 'a{}'))
    const before = insertCSS.mock.calls.length
    el.dispatchEvent(new Event('dom-ready'))
    expect(insertCSS.mock.calls.length).toBe(before + 1)
  })

  it('injects again for a guest whose dom-ready fired before the hook listened', () => {
    const { el, insertCSS } = webview(true)
    renderHook(() => useInjectedCss(el, 'a{}'))
    expect(insertCSS).toHaveBeenCalledTimes(2)
  })
})
