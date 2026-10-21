import type {
  ExtensionPanelContext,
  ExtensionPanelSource,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { usePanelVisibility } from '@/lib/extensions/panelVisibility'
import { registerPanelWebview } from '@/lib/extensions/panelWebviews'
import { useGuestReady, useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useInjectedCss, usePanelThemeCss } from '@/lib/theme/panelThemeInjection'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { PanelRoute } from '@/stores/app/sidePanelStore'

const EXTENSION_PARTITION_PREFIX = 'ostia-ext-'

export function ExtensionSidePanel({
  extId,
  workspaceId,
  focusKey,
  route,
  hidden = false,
}: {
  extId: string
  workspaceId: string
  focusKey: string
  route?: PanelRoute
  hidden?: boolean
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const themeCss = usePanelThemeCss()
  const [source, setSource] = useState<ExtensionPanelSource | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const readyWebview = useGuestReady(webview)
  useSurfaceFocus(focusKey, () => readyWebview)
  const showing = useRef(false)
  showing.current = source?.ok === true

  const resolve = useCallback(
    (isAlive: () => boolean) => {
      if (!showing.current) setSource(null)
      const context: ExtensionPanelContext = route
        ? { workspaceId, locale, path: route.path }
        : { workspaceId, locale }
      window.ostia.extensions
        .panel(extId, context)
        .then((res) => {
          if (isAlive()) setSource(res)
        })
        .catch((err: unknown) => {
          if (isAlive()) {
            setSource({ ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
    },
    [extId, workspaceId, locale, route],
  )

  useEffect(() => {
    let alive = true
    resolve(() => alive)
    return () => {
      alive = false
    }
  }, [resolve])

  useInjectedCss(webview, themeCss)
  usePanelVisibility(webview, hidden)
  useEffect(() => registerPanelWebview(focusKey, webview), [focusKey, webview])

  useEffect(() => {
    const el = webview
    if (!el) return
    const onFail = (e: Event): void => {
      const failed = e as unknown as { errorCode: number; isMainFrame: boolean }
      if (failed.isMainFrame && failed.errorCode !== -3) {
        setSource({ ok: false, error: d.extensions.panelUnreachable })
      }
    }
    el.addEventListener('did-fail-load', onFail)
    return () => el.removeEventListener('did-fail-load', onFail)
  }, [webview, d])

  if (!source) return <PanelMessage text={d.extensions.loading} />
  if (!source.ok) {
    return (
      <PanelMessage text={source.error}>
        <Button variant="outline" size="sm" onClick={() => resolve(() => true)}>
          {d.extensions.retry}
        </Button>
      </PanelMessage>
    )
  }
  return (
    <div className="extension-surface">
      <webview
        ref={setWebview}
        className="extension-webview"
        src={source.src}
        partition={`${EXTENSION_PARTITION_PREFIX}${extId}`}
      />
    </div>
  )
}

function PanelMessage({
  text,
  children,
}: {
  text: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <EmptyState
      variant="surface"
      size="sm"
      className="h-full w-full bg-surface-1"
      desc={text}
      descClassName="text-ui-sm"
    >
      {children}
    </EmptyState>
  )
}
