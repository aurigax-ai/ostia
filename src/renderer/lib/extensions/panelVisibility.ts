import {
  PANEL_VISIBILITY_EVENT,
  type PanelVisibility,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { WebviewTag } from 'electron'
import { useEffect } from 'react'

export function usePanelVisibility(webview: HTMLElement | null, hidden: boolean): void {
  useEffect(() => {
    const wv = webview as unknown as WebviewTag | null
    if (!wv) return
    const detail: PanelVisibility = { hidden }
    const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(PANEL_VISIBILITY_EVENT)}, { detail: ${JSON.stringify(detail)} }))`
    const tell = (): void => {
      try {
        wv.executeJavaScript(script).catch(() => undefined)
      } catch {}
    }
    tell()
    webview?.addEventListener('dom-ready', tell)
    return () => webview?.removeEventListener('dom-ready', tell)
  }, [webview, hidden])
}
