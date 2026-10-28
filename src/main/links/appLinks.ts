import { homedir } from 'node:os'
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from 'electron'
import { appLinkScheme, browserPageOf, externalHref } from '../../shared/common/externalLinks'
import type { AppLinkInfo, OpenLinkResult } from '../../shared/files/filesApi'
import {
  appLinkAsks,
  parseAllowedAppSchemes,
  parseAskBeforeOpeningApps,
} from '../../shared/terminal/appLinkSettings'
import { fromAppWindow } from '../platform/appWindowSender'
import { readSettingsFile } from '../platform/settingsFile'
import { type HandlerLookup, handlerName, systemHandlerLookup } from './appHandler'
import {
  type BrowserHost,
  type BrowserLaunch,
  browserLaunch,
  isExecutable,
  startBrowser,
} from './browserPages'

export interface AppLinkDeps {
  appWindows: () => Iterable<BrowserWindow>
  readSettings: () => ReturnType<typeof readSettingsFile>
  openExternal: (href: string) => Promise<void>
  lookup: HandlerLookup
  browser: BrowserHost
  startBrowser: (launch: BrowserLaunch, env: NodeJS.ProcessEnv) => Promise<boolean>
}

type Target =
  | { kind: 'direct'; href: string }
  | { kind: 'app'; href: string; scheme: string; app: string; start: () => Promise<boolean> }

type Resolved = Target | { kind: 'refused'; error: 'blocked' | 'no-handler' }

async function resolve(deps: AppLinkDeps, raw: string): Promise<Resolved> {
  const href = externalHref(raw, { apps: true })
  if (!href) return { kind: 'refused', error: 'blocked' }
  const scheme = appLinkScheme(href)
  if (!scheme) return { kind: 'direct', href }
  const page = browserPageOf(href)
  if (page) {
    const launch = browserLaunch(page, href, deps.browser)
    if (!launch) return { kind: 'refused', error: 'no-handler' }
    return {
      kind: 'app',
      href,
      scheme,
      app: launch.app,
      start: () => deps.startBrowser(launch, deps.browser.env),
    }
  }
  const name = await handlerName(href, deps.lookup)
  if (!name) return { kind: 'refused', error: 'no-handler' }
  return {
    kind: 'app',
    href,
    scheme,
    app: name,
    start: () => openHref(deps, href),
  }
}

function openHref(deps: AppLinkDeps, href: string): Promise<boolean> {
  return deps.openExternal(href).then(
    () => true,
    () => false,
  )
}

function asks(deps: AppLinkDeps, scheme: string): boolean {
  const terminal = deps.readSettings().terminal
  return appLinkAsks(
    {
      askBeforeOpeningApps: parseAskBeforeOpeningApps(terminal?.askBeforeOpeningApps),
      allowedAppSchemes: parseAllowedAppSchemes(terminal?.allowedAppSchemes),
    },
    scheme,
  )
}

export async function appLinkInfo(
  deps: AppLinkDeps,
  e: IpcMainInvokeEvent,
  raw: unknown,
): Promise<AppLinkInfo> {
  if (!fromAppWindow(deps.appWindows, e) || typeof raw !== 'string') {
    return { ok: false, error: 'blocked' }
  }
  const target = await resolve(deps, raw)
  if (target.kind === 'app') return { ok: true, app: target.app }
  return { ok: false, error: target.kind === 'refused' ? target.error : 'blocked' }
}

export async function openLink(
  deps: AppLinkDeps,
  e: IpcMainInvokeEvent,
  raw: unknown,
  confirmed: unknown,
): Promise<OpenLinkResult> {
  if (!fromAppWindow(deps.appWindows, e) || typeof raw !== 'string') {
    return { ok: false, error: 'blocked' }
  }
  const target = await resolve(deps, raw)
  if (target.kind === 'refused') return { ok: false, error: target.error }
  if (target.kind === 'app' && confirmed !== true && asks(deps, target.scheme)) {
    return { ok: false, error: 'not-allowed' }
  }
  const opened = target.kind === 'app' ? await target.start() : await openHref(deps, target.href)
  return opened ? { ok: true } : { ok: false, error: 'failed' }
}

export function systemAppLinkDeps(appWindows: () => Iterable<BrowserWindow>): AppLinkDeps {
  return {
    appWindows,
    readSettings: readSettingsFile,
    openExternal: (href) => shell.openExternal(href),
    lookup: systemHandlerLookup(),
    browser: {
      platform: process.platform,
      env: process.env,
      home: homedir(),
      exists: isExecutable,
    },
    startBrowser,
  }
}

export function registerAppLinkIpc(deps: AppLinkDeps): void {
  ipcMain.handle('shell:link-info', (e, raw: unknown) => appLinkInfo(deps, e, raw))
  ipcMain.handle('shell:open-link', (e, raw: unknown, confirmed: unknown) =>
    openLink(deps, e, raw, confirmed),
  )
}
