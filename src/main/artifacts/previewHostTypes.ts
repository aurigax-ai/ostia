import type { PreviewEvent, PreviewTheme } from '../../shared/artifacts/htmlPreview'
import type { PreviewSource } from './previewFiles'

export interface PreviewBuild {
  document: string
  inputs: readonly string[]
}

export interface PreviewSession {
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => void
  }
  webRequest: {
    onBeforeRequest: (
      listener: (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void,
    ) => void
  }
  setProxy: (config: { proxyRules: string; proxyBypassRules: string }) => Promise<void>
  setPermissionRequestHandler: (
    handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ) => void
  setPermissionCheckHandler: (handler: (wc: unknown, permission: string) => boolean) => void
  on: (event: 'will-download', listener: (event: { preventDefault: () => void }) => void) => void
  clearStorageData: () => Promise<void>
}

export interface PreviewGuest {
  id: number
  session: unknown
  isDestroyed: () => boolean
  getOSProcessId: () => number
  reload: () => void
  executeJavaScript: (code: string) => Promise<unknown>
  forcefullyCrashRenderer: () => void
  setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => void
  setWebRTCIPHandlingPolicy: (policy: 'disable_non_proxied_udp') => void
  setBackgroundThrottling: (allowed: boolean) => void
  debugger: {
    isAttached: () => boolean
    attach: (protocolVersion?: string) => void
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
  // biome-ignore lint/suspicious/noExplicitAny: Electron's per-event listener signatures differ.
  on: (event: any, listener: (...args: any[]) => void) => unknown
}

export interface ProcessUse {
  pid: number
  memoryBytes: number
  cpuPercent: number
}

export interface PreviewHostDeps {
  sessionOf: (partition: string) => PreviewSession
  confine: (path: string) => string | null
  servesFolder: (dir: string) => boolean
  ownsPane: (windowId: string, paneId: string) => boolean
  send: (windowId: string, event: PreviewEvent) => void
  processes: () => ProcessUse[]
  build: (source: PreviewSource, theme: PreviewTheme) => Promise<PreviewBuild>
  now?: () => number
}
