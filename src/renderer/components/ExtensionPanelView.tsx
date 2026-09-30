import type { ExtensionPanelSource } from '@shared/extensions'
import type { WebviewTag } from 'electron'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { panelThemeCss } from '../lib/panelTheme'
import { themedTokens, useEffectiveTheme } from '../lib/theme'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Button } from './ui/button'

export const EXTENSION_PARTITION_PREFIX = 'pine-ext-'

function useThemeCss(): string {
  const activeTheme = useEffectiveTheme()
  const accent = useSettingsStore((s) => s.appearance.accent)
  const ui = useSettingsStore((s) => s.appearance.ui.family)
  const mono = useSettingsStore((s) => s.appearance.terminal.family)
  return useMemo(
    () => panelThemeCss(activeTheme ? themedTokens(activeTheme, accent).tokens : {}, { ui, mono }),
    [activeTheme, accent, ui, mono],
  )
}

export function ExtensionPanelView({
  extId,
  workspaceId,
}: {
  extId: string
  workspaceId: string
}): JSX.Element {
  const d = useDict()
  const info = useExtensionsStore((s) => s.list.find((e) => e.id === extId))
  const enabled = info?.enabled ?? false
  const locale = useSettingsStore((s) => s.locale)
  const themeCss = useThemeCss()
  const [source, setSource] = useState<ExtensionPanelSource | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)

  const resolve = useCallback(
    (isAlive: () => boolean) => {
      setSource(null)
      window.pine.extensions
        .panel(extId, { workspaceId, locale })
        .then((res) => {
          if (isAlive()) setSource(res)
        })
        .catch((err: unknown) => {
          if (isAlive()) {
            setSource({ ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
    },
    [extId, workspaceId, locale],
  )

  useEffect(() => {
    if (!enabled) return
    let alive = true
    resolve(() => alive)
    return () => {
      alive = false
    }
  }, [enabled, resolve])

  const applyTheme = useCallback(() => {
    const wv = webview as unknown as WebviewTag | null
    try {
      wv?.insertCSS(themeCss).catch(() => undefined)
    } catch {}
  }, [webview, themeCss])

  useEffect(() => applyTheme(), [applyTheme])

  useEffect(() => {
    const el = webview
    if (!el) return
    const onFail = (e: Event): void => {
      const failed = e as unknown as { errorCode: number; isMainFrame: boolean }
      if (failed.isMainFrame && failed.errorCode !== -3) {
        setSource({ ok: false, error: d.extensions.panelUnreachable })
      }
    }
    el.addEventListener('dom-ready', applyTheme)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      el.removeEventListener('dom-ready', applyTheme)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [webview, applyTheme, d])

  if (!info) return <PanelMessage text={fmt(d.extensions.notInstalled, { id: extId })} />
  if (!enabled) return <PanelMessage text={fmt(d.extensions.panelDisabled, { name: info.name })} />
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
}: { text: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-surface-1 p-4 text-center text-fg-muted text-ui-sm">
      <span>{text}</span>
      {children}
    </div>
  )
}
