import {
  PANEL_TOOLBAR_EVENT,
  type PanelToolbarEvent,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { WebviewTag } from 'electron'

interface Entry {
  webview: HTMLElement
  loaded: boolean
  waiting: PanelToolbarEvent[]
}

const entries = new Map<string, Entry>()
const waitingForMount = new Map<string, PanelToolbarEvent[]>()
const WAITING_MAX = 8

function dispatch(webview: HTMLElement, event: PanelToolbarEvent): void {
  const tag = webview as unknown as WebviewTag
  const script = `window.dispatchEvent(new CustomEvent(${JSON.stringify(PANEL_TOOLBAR_EVENT)}, { detail: ${JSON.stringify(event)} }))`
  try {
    if (event.kind === 'action') tag.focus()
    tag.executeJavaScript(script).catch(() => undefined)
  } catch {}
}

function remember(list: PanelToolbarEvent[], event: PanelToolbarEvent): PanelToolbarEvent[] {
  return [...list, event].slice(-WAITING_MAX)
}

export function registerPanelWebview(key: string, webview: HTMLElement | null): () => void {
  if (!webview) return () => {}
  const entry: Entry = { webview, loaded: false, waiting: waitingForMount.get(key) ?? [] }
  waitingForMount.delete(key)
  entries.set(key, entry)
  const onStart = (): void => {
    entry.loaded = false
  }
  const onStop = (): void => {
    entry.loaded = true
    const queued = entry.waiting
    entry.waiting = []
    for (const event of queued) dispatch(webview, event)
  }
  webview.addEventListener('did-start-loading', onStart)
  webview.addEventListener('did-stop-loading', onStop)
  return () => {
    webview.removeEventListener('did-start-loading', onStart)
    webview.removeEventListener('did-stop-loading', onStop)
    if (entries.get(key) === entry) entries.delete(key)
  }
}

export function sendPanelToolbarEvent(key: string, event: PanelToolbarEvent): void {
  const entry = entries.get(key)
  if (!entry) {
    waitingForMount.set(key, remember(waitingForMount.get(key) ?? [], event))
    return
  }
  if (entry.loaded) dispatch(entry.webview, event)
  else entry.waiting = remember(entry.waiting, event)
}
