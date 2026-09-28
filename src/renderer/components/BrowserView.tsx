import type { WebviewTag } from 'electron'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { useLayoutStore } from '../stores/layoutStore'
import { IconButton } from './IconButton'

function resolveAddress(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export function BrowserView({
  sessionId,
  paneId,
  url,
}: {
  sessionId: string
  paneId: string
  url?: string
}): JSX.Element {
  const d = useDict()
  const webviewRef = useRef<HTMLElement | null>(null)
  const startUrl = useRef(url || 'about:blank')
  const lastAppliedUrlRef = useRef(startUrl.current)
  const readyRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)
  const [address, setAddress] = useState(startUrl.current)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

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
    setAddress(url)
    load(url)
  }, [url, load])

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return

    const syncNavState = (): void => {
      const ok = withGuest((wv) => {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      })
      if (!ok) {
        setCanGoBack(false)
        setCanGoForward(false)
      }
    }
    const onNavigate = (e: Event): void => {
      const { url: navigatedUrl, isMainFrame } = e as unknown as {
        url: string
        isMainFrame?: boolean
      }
      if (isMainFrame === false) return
      setAddress(navigatedUrl)
      syncNavState()
      lastAppliedUrlRef.current = navigatedUrl
      useLayoutStore.getState().setUrl(sessionId, paneId, navigatedUrl)
    }
    const onFailLoad = (e: Event): void => {
      const failed = e as unknown as {
        errorCode: number
        validatedURL: string
        isMainFrame: boolean
      }
      if (failed.errorCode === -3 || !failed.isMainFrame) return
      setAddress(failed.validatedURL)
      syncNavState()
    }

    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('did-fail-load', onFailLoad)
    return () => {
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('did-fail-load', onFailLoad)
    }
  }, [sessionId, paneId, withGuest])

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return
    const onDomReady = (): void => {
      readyRef.current = true
      withGuest((wv) => window.pine?.browser?.register?.(paneId, wv.getWebContentsId()))
      const pending = pendingUrlRef.current
      if (pending) load(pending)
    }
    el.addEventListener('dom-ready', onDomReady)
    return () => {
      el.removeEventListener('dom-ready', onDomReady)
      window.pine?.browser?.unregister?.(paneId)
    }
  }, [paneId, withGuest, load])

  const navigate = (raw: string): void => {
    const next = resolveAddress(raw)
    lastAppliedUrlRef.current = next
    setAddress(next)
    load(next)
  }

  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(address)
  }

  return (
    <div className="browser-surface">
      <div className="browser-toolbar">
        <IconButton
          icon={ArrowLeft}
          label={d.browser.back}
          disabled={!canGoBack}
          onClick={() => withGuest((wv) => wv.goBack())}
        />
        <IconButton
          icon={ArrowRight}
          label={d.browser.forward}
          disabled={!canGoForward}
          onClick={() => withGuest((wv) => wv.goForward())}
        />
        <IconButton
          icon={RotateCw}
          label={d.browser.reload}
          onClick={() => withGuest((wv) => wv.reload())}
        />
        <input
          className="browser-address"
          aria-label={d.browser.address}
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={onAddressKeyDown}
        />
      </div>
      <webview
        ref={(el) => {
          webviewRef.current = el
        }}
        className="browser-webview"
        src={startUrl.current}
        partition={`pine-browser-${paneId}`}
      />
    </div>
  )
}
