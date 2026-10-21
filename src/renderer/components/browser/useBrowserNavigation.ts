import type { WebviewTag } from 'electron'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { resolveAddress } from '@/lib/browser/browserAddress'
import { useSettingsStore } from '@/stores/app/settingsStore'

export const BLANK_PAGE = 'about:blank'

function shownAddress(url: string): string {
  return url === BLANK_PAGE ? '' : url
}

interface BrowserNavigationParams {
  url?: string
}

export function useBrowserNavigation({ url }: BrowserNavigationParams) {
  const webviewRef = useRef<HTMLElement | null>(null)
  const startUrl = useRef(url || BLANK_PAGE)
  const lastAppliedUrlRef = useRef(startUrl.current)
  const readyRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)
  const staleSrcRef = useRef<string | null>(null)
  const [address, setAddress] = useState(shownAddress(startUrl.current))
  const [src, setSrc] = useState(startUrl.current)
  const editingRef = useRef(false)
  const showAddress = useCallback((next: string): void => {
    if (!editingRef.current) setAddress(shownAddress(next))
  }, [])
  const srcRef = useRef(src)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loadError, setLoadError] = useState<{ url: string; reason: string } | null>(null)
  const [navCount, setNavCount] = useState(0)
  const addressRef = useRef<HTMLInputElement | null>(null)

  const withGuest = useCallback((fn: (wv: WebviewTag) => void): boolean => {
    const wv = webviewRef.current as unknown as WebviewTag | null
    if (!wv || !readyRef.current) return false
    try {
      fn(wv)
      return true
    } catch {
      readyRef.current = false
      return false
    }
  }, [])

  const load = useCallback(
    (next: string): void => {
      if (next !== srcRef.current) {
        if (!readyRef.current) staleSrcRef.current ??= srcRef.current
        srcRef.current = next
        pendingUrlRef.current = null
        setSrc(next)
        return
      }
      const ok = withGuest((wv) => {
        wv.loadURL(next).catch(() => undefined)
      })
      pendingUrlRef.current = ok ? null : next
    },
    [withGuest],
  )

  useEffect(() => {
    if (url === undefined || url === lastAppliedUrlRef.current) return
    lastAppliedUrlRef.current = url
    setAddress(shownAddress(url))
    load(url)
  }, [url, load])

  const navigate = (raw: string): void => {
    editingRef.current = false
    const next = resolveAddress(raw, useSettingsStore.getState().browser)
    setLoadError(null)
    lastAppliedUrlRef.current = next
    setAddress(shownAddress(next))
    load(next)
  }

  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(address)
    if (e.key === 'Escape') {
      editingRef.current = false
      setAddress(shownAddress(lastAppliedUrlRef.current))
    }
  }

  return {
    webviewRef,
    lastAppliedUrlRef,
    readyRef,
    pendingUrlRef,
    staleSrcRef,
    address,
    setAddress,
    src,
    editingRef,
    showAddress,
    srcRef,
    canGoBack,
    setCanGoBack,
    canGoForward,
    setCanGoForward,
    loadError,
    setLoadError,
    navCount,
    setNavCount,
    addressRef,
    withGuest,
    load,
    navigate,
    onAddressKeyDown,
  }
}
