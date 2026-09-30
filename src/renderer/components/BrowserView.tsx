import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CrosshairIcon,
  DatabaseIcon,
} from '@phosphor-icons/react'
import type { PickCapture, PickTheme } from '@shared/pick'
import type { WebviewTag } from 'electron'
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { resolveAddress } from '../lib/browserAddress'
import type { PickTarget } from '../lib/pickTargets'
import { sendPickToPane } from '../lib/sendPick'
import { terminalTitle } from '../lib/terminalTitle'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { BrowserStoragePanel } from './BrowserStoragePanel'
import { IconButton } from './IconButton'
import { LoginButton } from './LoginButton'
import { PickSendPanel, useAgentTargets } from './PickSendPanel'
import { Button } from './ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty'
import { Input } from './ui/input'

const STATUS_MS = 6000

function pickTheme(): PickTheme {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string): string => css.getPropertyValue(name).trim()
  return { accent: read('--brand'), surface: read('--surface-3'), fg: read('--fg') }
}

export function BrowserView({
  workspaceId,
  paneId,
  url,
}: {
  workspaceId: string
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
  const [src, setSrc] = useState(startUrl.current)
  const editingRef = useRef(false)
  const showAddress = useCallback((next: string): void => {
    if (!editingRef.current) setAddress(next)
  }, [])
  const srcRef = useRef(src)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loadError, setLoadError] = useState<{ url: string; reason: string } | null>(null)
  const [storageOpen, setStorageOpen] = useState(false)
  const [navCount, setNavCount] = useState(0)

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
      setNavCount((n) => n + 1)
      setLoadError(null)
      showAddress(navigatedUrl)
      syncNavState()
      lastAppliedUrlRef.current = navigatedUrl
      useLayoutStore.getState().setUrl(workspaceId, paneId, navigatedUrl)
    }
    const onFailLoad = (e: Event): void => {
      const failed = e as unknown as {
        errorCode: number
        errorDescription: string
        validatedURL: string
        isMainFrame: boolean
      }
      if (failed.errorCode === -3 || !failed.isMainFrame) return
      showAddress(failed.validatedURL)
      setLoadError({
        url: failed.validatedURL,
        reason: failed.errorDescription || String(failed.errorCode),
      })
      syncNavState()
    }
    const onTitle = (e: Event): void => {
      const title = terminalTitle((e as unknown as { title: string }).title ?? '')
      if (title) useLayoutStore.getState().setTitle(workspaceId, paneId, title)
    }

    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('did-fail-load', onFailLoad)
    el.addEventListener('page-title-updated', onTitle)
    return () => {
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      el.removeEventListener('did-fail-load', onFailLoad)
    }
  }, [workspaceId, paneId, withGuest, showAddress])

  useEffect(() => {
    const el = webviewRef.current
    if (!el) return
    const onDomReady = (): void => {
      readyRef.current = true
      withGuest((wv) => wv.setZoomFactor(useSettingsStore.getState().browser.defaultZoom / 100))
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

  const [picking, setPicking] = useState<{ byAgent: boolean } | null>(null)
  const [capture, setCapture] = useState<PickCapture | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const targets = useAgentTargets(workspaceId)

  useEffect(
    () =>
      window.pine?.browser?.onPickState?.((state) => {
        if (state.paneId !== paneId) return
        setPicking(state.active ? { byAgent: state.byAgent } : null)
      }),
    [paneId],
  )

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), STATUS_MS)
    return () => clearTimeout(timer)
  }, [status])

  const togglePick = async (): Promise<void> => {
    if (picking) {
      window.pine.browser.pickCancel(paneId)
      return
    }
    setCapture(null)
    setStatus(null)
    setPicking({ byAgent: false })
    withGuest((wv) => wv.focus())
    const outcome = await window.pine.browser.pickStart(paneId, pickTheme())
    setPicking(null)
    if (outcome.ok) setCapture(outcome.capture)
    else if (outcome.error !== 'cancelled' && outcome.error !== 'busy') {
      setStatus(fmt(d.browser.pickFailed, { reason: outcome.error }))
    }
  }

  const send = async (target: PickTarget, note: string): Promise<void> => {
    if (!capture) return
    setSending(true)
    try {
      const res = await sendPickToPane({
        capture,
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        note,
      })
      if (res.ok) {
        setCapture(null)
        setStatus(
          fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }),
        )
      } else {
        setStatus(fmt(d.send.sendFailed, { reason: res.error }))
      }
    } finally {
      setSending(false)
    }
  }

  const navigate = (raw: string): void => {
    editingRef.current = false
    const next = resolveAddress(raw, useSettingsStore.getState().browser)
    setLoadError(null)
    lastAppliedUrlRef.current = next
    setAddress(next)
    load(next)
  }

  const onAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') navigate(address)
    if (e.key === 'Escape') {
      editingRef.current = false
      setAddress(lastAppliedUrlRef.current)
    }
  }

  return (
    <div className="browser-surface relative">
      <div className="browser-toolbar">
        <IconButton
          icon={ArrowLeftIcon}
          label={d.browser.back}
          disabled={!canGoBack}
          onClick={() => withGuest((wv) => wv.goBack())}
        />
        <IconButton
          icon={ArrowRightIcon}
          label={d.browser.forward}
          disabled={!canGoForward}
          onClick={() => withGuest((wv) => wv.goForward())}
        />
        <IconButton
          icon={ArrowClockwiseIcon}
          label={d.browser.reload}
          onClick={() => withGuest((wv) => wv.reload())}
        />
        <Input
          className="browser-address h-6 flex-1 font-mono text-ui-sm md:text-ui-sm"
          aria-label={d.browser.address}
          value={address}
          spellCheck={false}
          onChange={(e) => {
            editingRef.current = true
            setAddress(e.target.value)
          }}
          onBlur={() => {
            editingRef.current = false
          }}
          onKeyDown={onAddressKeyDown}
        />
        <IconButton
          icon={CrosshairIcon}
          label={picking ? d.browser.pickStop : d.browser.pick}
          aria-pressed={picking !== null}
          onClick={() => void togglePick()}
        />
        <LoginButton paneId={paneId} pageKey={navCount} onStatus={setStatus} />
        <IconButton
          icon={DatabaseIcon}
          label={storageOpen ? d.browser.storageHide : d.browser.storageShow}
          aria-pressed={storageOpen}
          onClick={() => setStorageOpen((open) => !open)}
        />
      </div>
      {picking || status ? (
        <output className="block flex-none border-line border-b bg-surface-2 px-3 py-1 text-fg-muted text-ui-sm">
          {picking ? (picking.byAgent ? d.browser.pickHintAgent : d.browser.pickHint) : status}
        </output>
      ) : null}
      {capture ? (
        <PickSendPanel
          id={capture.id}
          summary={capture.label || capture.selector}
          noteLabel={d.browser.note}
          notePlaceholder={d.browser.notePlaceholder}
          closeLabel={d.browser.closeSend}
          targets={targets}
          sending={sending}
          onSend={(target, note) => void send(target, note)}
          onClose={() => setCapture(null)}
        />
      ) : null}
      <div className="browser-stage">
        <webview
          ref={(el) => {
            webviewRef.current = el
          }}
          className="browser-webview"
          src={src}
          partition={`pine-browser-${paneId}`}
        />
        {loadError ? (
          <Empty className="browser-error" role="alert">
            <EmptyHeader className="max-w-full">
              <EmptyTitle className="text-fg text-ui-base">{d.browser.loadFailed}</EmptyTitle>
              <EmptyDescription className="font-mono text-ui-sm [overflow-wrap:anywhere]">
                {loadError.url}
              </EmptyDescription>
              <EmptyDescription className="text-ui-sm">{loadError.reason}</EmptyDescription>
            </EmptyHeader>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => navigate(loadError.url)}
            >
              {d.browser.retry}
            </Button>
          </Empty>
        ) : null}
      </div>
      {storageOpen ? (
        <BrowserStoragePanel
          paneId={paneId}
          refreshKey={navCount}
          onClose={() => setStorageOpen(false)}
        />
      ) : null}
    </div>
  )
}
