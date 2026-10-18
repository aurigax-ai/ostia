import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useWebviewEvents } from './useWebviewEvents'

function setup(initiallyReached: boolean) {
  let reached = initiallyReached
  const el = document.createElement('webview')
  Object.assign(el, { setZoomFactor: vi.fn(), getURL: () => 'about:blank' })
  Object.defineProperty(el, 'getWebContentsId', {
    value: () => {
      if (!reached) throw new Error('The WebView must be attached to the DOM')
      return 7
    },
  })
  const register = vi.fn()
  Object.assign(window, { ostia: { browser: { register, unregister: vi.fn() } } })
  const readyRef = { current: false }
  const load = vi.fn()
  const fn = vi.fn()
  renderHook(() =>
    useWebviewEvents({
      workspaceId: 'w',
      paneId: 'p',
      partition: 'persist:x',
      webviewRef: { current: el },
      readyRef,
      srcRef: { current: 'http://localhost/' },
      staleSrcRef: { current: null },
      pendingUrlRef: { current: 'http://localhost/next' },
      lastAppliedUrlRef: { current: '' },
      withGuest: (run) => {
        if (!readyRef.current) return false
        run(el as never)
        return true
      },
      load,
      showAddress: fn,
      setCanGoBack: fn,
      setCanGoForward: fn,
      setNavCount: fn,
      setLoadError: fn,
      setFindResult: fn,
    }),
  )
  return {
    el,
    register,
    load,
    readyRef,
    reach: () => {
      reached = true
    },
  }
}

describe('useWebviewEvents', () => {
  it('registers the guest when dom-ready fires after the hook listens', () => {
    const { el, register, load, reach } = setup(false)
    expect(register).not.toHaveBeenCalled()
    reach()
    el.dispatchEvent(new Event('dom-ready'))
    expect(register).toHaveBeenCalledWith('p', 7)
    expect(load).toHaveBeenCalledWith('http://localhost/next')
  })

  it('registers a guest whose dom-ready fired before the hook listened', () => {
    const { register, load, readyRef } = setup(true)
    expect(readyRef.current).toBe(true)
    expect(register).toHaveBeenCalledWith('p', 7)
    expect(load).toHaveBeenCalledWith('http://localhost/next')
  })
})
