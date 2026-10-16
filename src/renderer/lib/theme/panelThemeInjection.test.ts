import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useInjectedCss } from './panelThemeInjection'

function webview(guestReached: boolean) {
  const el = document.createElement('webview')
  let next = 0
  const insertCSS = vi.fn(async () => `key${++next}`)
  const removeInsertedCSS = vi.fn(async () => undefined)
  Object.assign(el, { insertCSS, removeInsertedCSS })
  Object.defineProperty(el, 'getWebContentsId', {
    value: () => {
      if (!guestReached) throw new Error('The WebView must be attached to the DOM')
      return 7
    },
  })
  return { el, insertCSS, removeInsertedCSS }
}

const settle = () => act(async () => undefined)

describe('useInjectedCss', () => {
  it('injects again when dom-ready fires after the hook listens', async () => {
    const { el, insertCSS } = webview(false)
    renderHook(() => useInjectedCss(el, 'a{}'))
    const before = insertCSS.mock.calls.length
    el.dispatchEvent(new Event('dom-ready'))
    expect(insertCSS.mock.calls.length).toBe(before + 1)
    await settle()
  })

  it('injects exactly once for a guest whose dom-ready fired before the hook listened', async () => {
    const { el, insertCSS } = webview(true)
    renderHook(() => useInjectedCss(el, 'a{}'))
    await settle()
    expect(insertCSS).toHaveBeenCalledTimes(1)
  })

  it('removes the old block when the theme changes', async () => {
    const { el, insertCSS, removeInsertedCSS } = webview(true)
    const { rerender } = renderHook(({ css }) => useInjectedCss(el, css), {
      initialProps: { css: 'a{}' },
    })
    await settle()
    rerender({ css: 'b{}' })
    await settle()
    expect(insertCSS).toHaveBeenCalledTimes(2)
    expect(removeInsertedCSS).toHaveBeenCalledWith('key1')
  })
})
