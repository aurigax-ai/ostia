import type { WebviewTag } from 'electron'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'

/** Bare hostnames/paths (no scheme) get an assumed `https://`; anything else falls back to a
 *  search. Good enough for Stage 1 (rendering only) — no omnibox heuristics beyond this. */
function resolveAddress(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed // already has a scheme
  if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/**
 * The in-app browser surface: an Electron `<webview>` (its own isolated guest process +
 * partition — no nodeIntegration on the guest) with a minimal chrome bar (back / forward /
 * reload / address). Stage 1 is rendering-only; agent automation (CDP) lands in a later stage.
 */
export function BrowserView({ url }: { url?: string }): JSX.Element {
  const webviewRef = useRef<HTMLElement | null>(null)
  const startUrl = useRef(url || 'about:blank')
  // The last url we've already applied (via the initial `src` or an imperative loadURL) —
  // lets the effect below tell "the pane's url prop changed" apart from "we just mounted".
  const lastAppliedUrlRef = useRef(startUrl.current)
  const [address, setAddress] = useState(startUrl.current)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  // Stable identity (only reads the ref, which never itself changes) so it's a safe,
  // exhaustive dependency for the effects below.
  const tag = useCallback(
    (): WebviewTag | null => webviewRef.current as unknown as WebviewTag | null,
    [],
  )

  // Mount-once surface: a "reuse this browser pane" navigation (browser.new targeting an
  // already-open browser pane) arrives here as a new `url` prop on the SAME long-lived
  // instance — re-drive the existing guest instead of relying on the (mount-only) `src` attr.
  useEffect(() => {
    if (url === undefined || url === lastAppliedUrlRef.current) return
    lastAppliedUrlRef.current = url
    setAddress(url)
    tag()?.loadURL(url)
  }, [url, tag])

  // Keep the chrome bar (address + back/forward state) in sync with the guest page.
  useEffect(() => {
    const el = webviewRef.current
    if (!el) return

    const syncNavState = (): void => {
      const wv = tag()
      setCanGoBack(wv?.canGoBack() ?? false)
      setCanGoForward(wv?.canGoForward() ?? false)
    }
    const onNavigate = (e: Event): void => {
      const { url: navigatedUrl } = e as unknown as { url: string }
      setAddress(navigatedUrl)
      syncNavState()
    }
    const onFailLoad = (e: Event): void => {
      const failed = e as unknown as {
        errorCode: number
        validatedURL: string
        isMainFrame: boolean
      }
      if (failed.errorCode === -3 || !failed.isMainFrame) return // ERR_ABORTED / sub-frame — ignore
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
  }, [tag])

  const navigate = (raw: string): void => {
    const next = resolveAddress(raw)
    lastAppliedUrlRef.current = next
    setAddress(next)
    tag()?.loadURL(next)
  }

  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(address)
  }

  return (
    <div className="browser-surface">
      <div className="browser-toolbar">
        <button
          type="button"
          className="iconbtn"
          disabled={!canGoBack}
          onClick={() => tag()?.goBack()}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="iconbtn"
          disabled={!canGoForward}
          onClick={() => tag()?.goForward()}
        >
          <ArrowRight size={14} />
        </button>
        <button type="button" className="iconbtn" onClick={() => tag()?.reload()}>
          <RotateCw size={14} />
        </button>
        <input
          className="browser-address"
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
        partition="persist:pine-browser"
      />
    </div>
  )
}
