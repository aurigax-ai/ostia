import type { WebviewTag } from 'electron'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useReducedMotion } from '@/lib/app/motion'
import { panelFontFaces } from '@/lib/theme/panelFontFaces'
import { panelThemeCss } from '@/lib/theme/panelTheme'
import { themedTokens, useEffectiveTheme } from '@/lib/theme/theme'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function usePanelThemeCss(): string {
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

export function useInjectedCss(webview: HTMLElement | null, css: string): () => void {
  const inserted = useRef<string | null>(null)
  const apply = useCallback(() => {
    const wv = webview as unknown as WebviewTag | null
    if (!wv) return
    try {
      const previous = inserted.current
      inserted.current = null
      if (previous) wv.removeInsertedCSS(previous).catch(() => undefined)
      wv.insertCSS(css)
        .then((key) => {
          inserted.current = key
        })
        .catch(() => undefined)
    } catch {}
  }, [webview, css])
  useEffect(() => {
    apply()
    if (!webview) return
    webview.addEventListener('dom-ready', apply)
    return () => webview.removeEventListener('dom-ready', apply)
  }, [webview, apply])
  return apply
}
