import {
  PORTABLE_CSP,
  portableSandbox,
  portableType,
  runsScripts,
} from '../../shared/artifacts/portable'
import type { PreviewSession } from './previewHostTypes'

const DEAD_PROXY = { proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' }

export function lockDownSession(
  session: Pick<
    PreviewSession,
    'setProxy' | 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'on'
  >,
  allows: (permission: string) => boolean,
): void {
  void session.setProxy(DEAD_PROXY).catch(() => {})
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(allows(permission)))
  session.setPermissionCheckHandler((_wc, permission) => allows(permission))
  session.on('will-download', (event) => event.preventDefault())
}

const HOST_SET_ATTRIBUTES = [
  'preload',
  'allowpopups',
  'nodeintegration',
  'nodeintegrationinsubframes',
  'plugins',
  'disablewebsecurity',
  'webpreferences',
  'blinkfeatures',
  'disableblinkfeatures',
  'enableblinkfeatures',
  'useragent',
  'httpreferrer',
]

export function hardenPreviewAttach(
  webPreferences: Electron.WebPreferences,
  params: Record<string, string>,
): void {
  webPreferences.preload = undefined
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.webviewTag = false
  webPreferences.disableDialogs = true
  webPreferences.navigateOnDragDrop = false
  webPreferences.autoplayPolicy = 'user-gesture-required'
  webPreferences.transparent = false
  webPreferences.experimentalFeatures = false
  webPreferences.plugins = false
  webPreferences.allowRunningInsecureContent = false
  webPreferences.enableBlinkFeatures = undefined
  webPreferences.disableBlinkFeatures = undefined
  for (const name of HOST_SET_ATTRIBUTES) {
    delete params[name]
  }
  Object.assign(webPreferences, { disablePopups: false })
}
function previewSandbox(type: ReturnType<typeof portableType>): string {
  return type && !runsScripts(type) ? portableSandbox(type) : 'allow-scripts allow-popups'
}

export function previewHeaders(file: string): Record<string, string> {
  const type = portableType(file)
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `${PORTABLE_CSP}, sandbox ${previewSandbox(type)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
  }
}
