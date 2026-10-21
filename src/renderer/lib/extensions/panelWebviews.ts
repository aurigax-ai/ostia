import {
  PANEL_TOOLBAR_EVENT,
  type PanelToolbarEvent,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { WebviewTag } from 'electron'

const webviews = new Map<string, HTMLElement>()

export function registerPanelWebview(key: string, webview: HTMLElement | null): () => void {
  if (!webview) return () => {}
  webviews.set(key, webview)
  return () => {
    if (webviews.get(key) === webview) webviews.delete(key)
  }
}

export function sendPanelToolbarEvent(key: string, event: PanelToolbarEvent): void {
  const webview = webviews.get(key) as unknown as WebviewTag | undefined
  if (!webview) return
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(PANEL_TOOLBAR_EVENT)}, { detail: ${JSON.stringify(event)} }))`
  try {
    if (event.kind === 'action') webview.focus()
    webview.executeJavaScript(script).catch(() => undefined)
  } catch {}
}
