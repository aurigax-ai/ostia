import type { ExtensionPanelContext, ExtensionPanelSource } from '@shared/extensions'
import type { WebviewTag } from 'electron'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useReducedMotion } from '../lib/motion'
import { panelFontFaces } from '../lib/panelFontFaces'
import { panelThemeCss } from '../lib/panelTheme'
import { themedTokens, useEffectiveTheme } from '../lib/theme'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Button } from './ui/button'
import { Empty, EmptyDescription } from './ui/empty'

export const EXTENSION_PARTITION_PREFIX = 'pine-ext-'

function useThemeCss(): string {
  const activeTheme = useEffectiveTheme()
  const accent = useSettingsStore((s) => s.appearance.accent)
  const ui = useSettingsStore((s) => s.appearance.ui)
  const code = useSettingsStore((s) => s.appearance.editor.family)
  const reducedMotion = useReducedMotion()
  return useMemo(
    () =>
      `${panelFontFaces([ui.family, code])}\n${panelThemeCss(
        activeTheme ? themedTokens(activeTheme, accent) : {},
        { ui: ui.family, code, size: ui.size, weight: ui.weight },
        activeTheme?.appearance ?? 'dark',
        reducedMotion,
      )}`,
    [activeTheme, accent, ui, code, reducedMotion],
  )
}

export function ExtensionPanelView({
  extId,
  workspaceId,
  paneId,
}: {
  extId: string
  workspaceId: string
  paneId: string
}): JSX.Element {
  const d = useDict()
  const info = useExtensionsStore((s) => s.list.find((e) => e.id === extId))
  const nav = useExtensionsStore((s) => s.panelNav[paneId])
  const enabled = info?.enabled ?? false
  const locale = useSettingsStore((s) => s.locale)
  const themeCss = useThemeCss()
  const [source, setSource] = useState<ExtensionPanelSource | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const showing = useRef(false)
  showing.current = source?.ok === true

  const resolve = useCallback(
    (isAlive: () => boolean) => {
      if (!showing.current) setSource(null)
      const context: ExtensionPanelContext = nav
        ? { workspaceId, locale, path: nav.path }
        : { workspaceId, locale }
      window.pine.extensions
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
    [extId, workspaceId, locale, nav],
  )

  useEffect(() => {
    if (!enabled) return
    let alive = true
    resolve(() => alive)
    return () => {
      alive = false
    }
  }, [enabled, resolve])

  const insertedCss = useRef<string | null>(null)
  const applyTheme = useCallback(() => {
    const wv = webview as unknown as WebviewTag | null
    if (!wv) return
    try {
      const previous = insertedCss.current
      insertedCss.current = null
      if (previous) wv.removeInsertedCSS(previous).catch(() => undefined)
      wv.insertCSS(themeCss)
        .then((key) => {
          insertedCss.current = key
        })
        .catch(() => undefined)
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
    <Empty className="h-full w-full bg-surface-1">
      <EmptyDescription className="text-ui-sm">{text}</EmptyDescription>
      {children}
    </Empty>
  )
}
