import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, session, shell, webContents } from 'electron'
import type { IPty } from 'node-pty'
import type { ExtensionResult } from '../shared/extensions'
import { PRODUCT_NAME } from '../shared/product'
import type {
  AppInfo,
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  ExternalEditorRequest,
  FsEntry,
  LifecycleEvent,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
  WorkspaceSnapshot,
} from '../shared/types'
import { registerAttentionMethods } from './attention'
import {
  type ConsoleEntry,
  PAGE_ERROR_CATCHER_JS,
  PINE_ERROR_PREFIX,
  clearGuestDialogPolicy,
  clearGuestFrame,
  clearGuestReactGrab,
  consoleLevelName,
  pushConsoleEntry,
  registerBrowseMethods,
} from './browse'
import { cancelPick, registerPickIpc, registerPickMethods } from './browsePick'
import { registerBusMethods } from './bus'
import { dropIdentity } from './capabilityStore'
import { controlSocketPath, registerControlServer, stopControlServer } from './controlServer'
import { registerDocsMethods } from './docs'
import { emitPlatformEvent, emitSessionState, platformEvents } from './events'
import { confirmForExtension } from './extensionConfirm'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import type { ExtensionRoot } from './extensionManifest'
import { ExtensionStore } from './extensionStore'
import { openInExternalEditor } from './externalEditor'
import { registerGatewayIpc, registerGatewayMethods } from './gateway'
import { configureGatewayControl, stopGateway } from './gateway/server'
import { clearGuestNetwork, watchGuestNetwork } from './guestNetwork'
import { getByPaneId, registerPane, removePane, removeWindow, windowOfSession } from './idRegistry'
import { killAllLsp, registerLspIpc } from './lsp'
import {
  postNotification,
  postPanelNotification,
  registerNotifyIpc,
  registerNotifyMethods,
} from './notify'
import { listPanes, listSessions, registerPaneListMethods } from './paneList'
import { resolveSafe } from './pathGuard'
import { killAllProcesses, registerProcessMethods } from './processManager'
import { PtySession, type SubscriberRole } from './ptySession'
import { removeSession, setSessionWorkDir, workDirForSession } from './sessionRegistry'
import {
  clearPersisted,
  dropRestoredScrollback,
  loadRestoredScrollback,
  loadSnapshot,
  parseSnapshot,
  pendingRestoredScrollback,
  saveScrollback,
  saveSnapshot,
  takeRestoredScrollback,
} from './sessionSnapshot'
import { type SettingsSyncHandle, startSettingsSync } from './settingsSyncIpc'
import { shellIntegrationSpawnOptions } from './shellIntegration'
import { registerVaultMethods } from './vault'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

let ptyModule: typeof import('node-pty') | null | undefined
function loadPty(): typeof import('node-pty') | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('node-pty')
    } catch (err) {
      console.error('[pty] node-pty unavailable — terminals disabled. Run: npm run rebuild', err)
      ptyModule = null
    }
  }
  return ptyModule ?? null
}

interface PtyEntry {
  pty: IPty
  session: PtySession
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
}

const ptys = new Map<string, PtyEntry>()
const PTY_BUFFER_CAP = 1_000_000
const DETACH_GRACE_MS = 3000

let restorePersistEnabled = true

const RESTORE_SEAM = '\x1b]133;D\x07\r\n\x1b[2m── session restored ──\x1b[0m\r\n'

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function openExternalSafe(url: string): boolean {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return false
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) return false
  void shell.openExternal(url)
  return true
}

function killPty(paneId: string): void {
  const entry = ptys.get(paneId)
  if (!entry) return
  if (entry.killTimer) clearTimeout(entry.killTimer)
  try {
    entry.pty.kill()
  } catch {}
  ptys.delete(paneId)
}

function expandHome(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function resolveCwd(cwd?: string): string {
  const home = homedir()
  const p = expandHome(cwd ?? home)
  try {
    if (statSync(p).isDirectory()) return p
  } catch {}
  return home
}

const windows = new Map<string, BrowserWindow>()
const commandsByWindow = new Map<string, CommandDescriptor[]>()

const browserPanes = new Map<string, number>()

const consoleBuffers = new Map<number, ConsoleEntry[]>()
const errorBuffers = new Map<number, ConsoleEntry[]>()

const terminalState = new Map<string, TerminalStateSnapshot>()

let extensionHost: ExtensionHost | null = null
let settingsSync: SettingsSyncHandle | null = null

const EXTENSION_PARTITION_PREFIX = 'pine-ext-'

function extensionRoots(): ExtensionRoot[] {
  const builtinDir = app.isPackaged
    ? join(process.resourcesPath, 'extensions')
    : join(app.getAppPath(), 'out/extensions')
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [
    { dir: builtinDir, builtin: true },
    { dir: join(configHome, PRODUCT_NAME, 'extensions'), builtin: false },
  ]
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function extensionOfPartition(partition: string | undefined): string | null {
  if (!partition?.startsWith(EXTENSION_PARTITION_PREFIX)) return null
  return partition.slice(EXTENSION_PARTITION_PREFIX.length)
}

function hardenExtensionGuest(guest: Electron.WebContents): void {
  const host = extensionHost
  if (!host) return
  const extId = host
    .panelExtensionIds()
    .find((id) => guest.session === session.fromPartition(`${EXTENSION_PARTITION_PREFIX}${id}`))
  if (!extId) return
  guest.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  guest.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string): void => {
    if (!host.isAllowedPanelUrl(extId, url)) e.preventDefault()
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)
}

function frameOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
  }
  return { frame: false }
}

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: true,
  }
}

function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => win.show())

  const emitMaximized = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const extId = extensionOfPartition(params.partition)
    const allowed = extId
      ? (extensionHost?.isAllowedPanelUrl(extId, params.src) ?? false)
      : params.partition?.startsWith('pine-browser')
    if (!allowed) {
      event.preventDefault()
      return
    }
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
  win.webContents.on('did-attach-webview', (_e, guest) => hardenExtensionGuest(guest))

  const wid = String(win.webContents.id)
  windows.set(wid, win)
  win.on('closed', () => {
    windows.delete(wid)
    commandsByWindow.delete(wid)
    for (const [paneId, wcId] of browserPanes) {
      if (getByPaneId(paneId)?.windowId === wid) {
        browserPanes.delete(paneId)
        consoleBuffers.delete(wcId)
        errorBuffers.delete(wcId)
        clearGuestFrame(wcId)
        clearGuestDialogPolicy(wcId)
        clearGuestReactGrab(wcId)
        clearGuestNetwork(wcId)
      }
    }
    removeWindow(wid)
    for (const entry of ptys.values()) {
      if (entry.subs.has(wid)) {
        entry.subs.delete(wid)
        entry.session.removeSubscriber(wid)
      }
    }
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    ...frameOptions(),
    webPreferences: baseWebPreferences(),
  })

  wireWindow(win)

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => 'pong' as const)
  ipcMain.handle('settings:path', () => join(app.getPath('userData'), 'settings.json'))
  ipcMain.handle('editor:open-external', (_e, req: ExternalEditorRequest) =>
    openInExternalEditor(req),
  )
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: PRODUCT_NAME,
      version: app.getVersion(),
      platform: process.platform,
    }),
  )

  ipcMain.on('session:save', (_e, snapshot: WorkspaceSnapshot | null) => {
    try {
      if (snapshot === null) {
        restorePersistEnabled = false
        clearPersisted()
        return
      }
      const parsed = parseSnapshot(snapshot)
      if (!parsed) return
      restorePersistEnabled = true
      saveSnapshot(parsed)
    } catch (err) {
      console.error('[session] snapshot save failed', err)
    }
  })
  ipcMain.handle('session:load', (): WorkspaceSnapshot | null => {
    try {
      return loadSnapshot()
    } catch (err) {
      console.error('[session] snapshot load failed', err)
      return null
    }
  })

  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(
    'window:is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  )

  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    if (event.type === 'pane-created') {
      const identity = registerPane({ windowId, sessionId: event.sessionId, paneId: event.paneId })
      extensionHost?.emitEvent('pane.created', {
        paneId: identity.externalId,
        sessionId: event.sessionId,
      })
    } else if (event.type === 'pane-closed') {
      const identity = getByPaneId(event.paneId)
      if (identity) {
        dropIdentity(identity.externalId)
        extensionHost?.emitEvent('pane.closed', {
          paneId: identity.externalId,
          sessionId: event.sessionId,
        })
      }
      dropRestoredScrollback(event.paneId)
      removePane(event.paneId)
      terminalState.delete(event.paneId)
    } else if (event.type === 'session-added') {
      setSessionWorkDir(event.sessionId, event.workDir)
    } else if (event.type === 'session-closed') {
      removeSession(event.sessionId)
    } else if (event.type === 'session-activated') {
    } else if (event.type === 'session-state') {
      emitSessionState(event.sessionId, event.state)
    }
  })

  ipcMain.on('commands:register', (e, descriptors: CommandDescriptor[]) => {
    commandsByWindow.set(String(e.sender.id), descriptors)
  })

  ipcMain.on('terminal:state', (_e, snapshot: TerminalStateSnapshot) => {
    const cur = terminalState.get(snapshot.paneId)
    if (!cur || snapshot.generation >= cur.generation) {
      const changed =
        !cur ||
        cur.cwd !== snapshot.cwd ||
        cur.running !== snapshot.running ||
        cur.blockCount !== snapshot.blockCount ||
        cur.lastExitCode !== snapshot.lastExitCode
      terminalState.set(snapshot.paneId, snapshot)
      if (changed) {
        const identity = getByPaneId(snapshot.paneId)
        if (identity) {
          emitTerminalExtensionEvents(identity.externalId, identity.sessionId, cur, snapshot)
          emitPlatformEvent('pane.state', {
            paneId: identity.externalId,
            generation: snapshot.generation,
            cwd: snapshot.cwd,
            running: snapshot.running,
            blockCount: snapshot.blockCount,
            lastExitCode: snapshot.lastExitCode,
          })
        }
      }
    }
  })

  ipcMain.on('browser:register', (e, paneId: string, webContentsId: number) => {
    const wid = String(e.sender.id)
    if (getByPaneId(paneId)?.windowId !== wid) return
    const gc = webContents.fromId(webContentsId)
    if (!gc || gc.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
    browserPanes.set(paneId, webContentsId)
    if (gc.listenerCount('console-message') === 0) {
      gc.on('console-message', (_event, level, message) => {
        const entry: ConsoleEntry = {
          level: consoleLevelName(level),
          text: message,
          ts: Date.now(),
        }
        pushConsoleEntry(consoleBuffers, webContentsId, entry)
        if (entry.level === 'error' || message.startsWith(PINE_ERROR_PREFIX)) {
          pushConsoleEntry(errorBuffers, webContentsId, entry)
        }
      })
      try {
        if (!gc.debugger.isAttached()) gc.debugger.attach('1.3')
        gc.debugger
          .sendCommand('Page.enable')
          .then(() =>
            gc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
              source: PAGE_ERROR_CATCHER_JS,
            }),
          )
          .catch(() => {})
      } catch {}
    }
    watchGuestNetwork(gc)
  })
  ipcMain.on('browser:unregister', (_e, paneId: string) => {
    cancelPick(paneId)
    const wcId = browserPanes.get(paneId)
    browserPanes.delete(paneId)
    if (wcId !== undefined) {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestFrame(wcId)
      clearGuestDialogPolicy(wcId)
      clearGuestReactGrab(wcId)
      clearGuestNetwork(wcId)
    }
  })
}

function emitTerminalExtensionEvents(
  paneId: string,
  sessionId: string,
  prev: TerminalStateSnapshot | undefined,
  next: TerminalStateSnapshot,
): void {
  const host = extensionHost
  if (!host) return
  if (next.cwd && prev?.cwd !== next.cwd) {
    host.emitEvent('cwd.changed', { paneId, sessionId, cwd: next.cwd })
  }
  if (next.running && !prev?.running) {
    host.emitEvent('command.started', { paneId, sessionId, cwd: next.cwd })
  } else if (!next.running && prev?.running) {
    host.emitEvent('command.finished', {
      paneId,
      sessionId,
      cwd: next.cwd,
      exitCode: next.lastExitCode,
    })
  }
}

function registerExtensionIpc(host: ExtensionHost): void {
  ipcMain.handle('extensions:list', () => host.list())
  ipcMain.handle('extensions:set-enabled', (_e, extId: string, enabled: boolean) =>
    host.setEnabled(String(extId), enabled === true),
  )
  ipcMain.handle('extensions:approve', (_e, extId: string) => host.approve(String(extId)))
  ipcMain.handle('extensions:sidebar', () => host.sidebarItems())
  ipcMain.handle(
    'extensions:invoke',
    (
      _e,
      extId: string,
      command: string,
      target: { sessionId: string | null; paneId: string | null },
    ): Promise<ExtensionResult> => {
      const paneId = target?.paneId ? getByPaneId(target.paneId)?.externalId : undefined
      const cwd = target?.paneId ? terminalState.get(target.paneId)?.cwd : undefined
      const caller = host.userCaller(target?.sessionId ?? null, {
        capabilities: host.commandCapabilities(extId, command),
        ...(paneId ? { paneId } : {}),
        ...(cwd ? { cwd } : {}),
      })
      return host.invoke(extId, command, null, caller)
    },
  )
  ipcMain.handle(
    'extensions:panel',
    (_e, extId: string, context: { sessionId: string; locale: string }) =>
      host.resolvePanel(String(extId), {
        sessionId: String(context?.sessionId ?? ''),
        locale: String(context?.locale ?? 'en'),
      }),
  )
}

function registerPtyIpc(): void {
  ipcMain.handle('pty:attach', (e, paneId: string, opts: PtySpawnOptions): PtyAttachResult => {
    const subId = String(e.sender.id)
    const mkSub = () => ({
      id: subId,
      role: (opts.role ?? 'owner') as 'owner' | 'observer',
      send: (data: string) => {
        if (!e.sender.isDestroyed()) e.sender.send(`pty:data:${paneId}`, data)
      },
    })

    const existing = ptys.get(paneId)
    if (existing) {
      if (existing.killTimer) {
        clearTimeout(existing.killTimer)
        existing.killTimer = null
      }
      existing.subs.set(subId, e.sender)
      existing.session.addLiveSubscriber(mkSub())
      const { data, cursor, dropped } = existing.session.since(opts.sinceCursor ?? 0)
      return { created: false, buffer: data, cursor, dropped }
    }

    const mod = loadPty()
    if (!mod) {
      return {
        created: false,
        buffer: '\r\n\x1b[38;2;239;89;111m node-pty unavailable — run: pnpm rebuild\x1b[0m\r\n',
        cursor: 0,
        dropped: false,
      }
    }
    const shell =
      opts.shell ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
    const integration = shellIntegrationSpawnOptions(shell, process.env)
    const identity = registerPane({ windowId: subId, sessionId: '', paneId })
    const pty = mod.spawn(shell, integration.args, {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: resolveCwd(opts.cwd),
      env: {
        ...process.env,
        ...integration.env,
        PINE_PANE_ID: identity.externalId,
        PINE_TOKEN: identity.token,
        PINE_WORKSPACE: opts.cwd ?? '',
        PINE_SOCKET: controlSocketPath(),
        PINE_CLI: join(app.getAppPath(), 'out/cli/index.js'),
        PINE_NODE: process.execPath,
      } as Record<string, string>,
    })
    const session = new PtySession({
      capBytes: PTY_BUFFER_CAP,
      onNoOwners: () => {
        if (ptys.get(paneId) !== entry || entry.killTimer) return
        entry.killTimer = setTimeout(() => killPty(paneId), DETACH_GRACE_MS)
      },
      onExit: (code) => {
        if (entry.killTimer) clearTimeout(entry.killTimer)
        entry.killTimer = null
        for (const wc of entry.subs.values()) {
          if (!wc.isDestroyed()) wc.send(`pty:exit:${paneId}`, code)
        }
        if (ptys.get(paneId) === entry) ptys.delete(paneId)
      },
    })
    const entry: PtyEntry = { pty, session, subs: new Map([[subId, e.sender]]), killTimer: null }
    ptys.set(paneId, entry)

    const history = takeRestoredScrollback(paneId)
    if (history) session.push(`${history}${RESTORE_SEAM}`)

    pty.onData((d) => session.push(d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped } = session.since(0)
    session.addLiveSubscriber(mkSub())
    return { created: true, buffer: data, cursor, dropped }
  })

  ipcMain.on('pty:detach', (e, paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return
    const subId = String(e.sender.id)
    entry.subs.delete(subId)
    entry.session.removeSubscriber(subId)
  })

  ipcMain.on('pty:write', (e, paneId: string, data: string) => {
    const entry = ptys.get(paneId)
    if (entry?.session.canWrite(String(e.sender.id))) entry.pty.write(data)
  })
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) => {
    try {
      ptys.get(paneId)?.pty.resize(cols || 80, rows || 24)
    } catch {}
  })
}

function registerFsIpc(): void {
  const allowedRoots = [homedir(), app.getPath('userData')]

  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] => {
    const safe = resolveSafe(dir, allowedRoots)
    if (safe === null) return []
    try {
      return readdirSync(safe, { withFileTypes: true })
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:read', (_e, path: string): string | null => {
    const safe = resolveSafe(path, allowedRoots)
    if (safe === null) return null
    try {
      return readFileSync(safe, 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:write', (_e, path: string, content: string): boolean => {
    const safe = resolveSafe(path, allowedRoots)
    if (safe === null) return false
    try {
      writeFileSync(safe, content, 'utf8')
      return true
    } catch {
      return false
    }
  })
}

export function listCommandsFor(windowId: string): CommandDescriptor[] {
  return commandsByWindow.get(windowId) ?? []
}

export function getTerminalState(paneId: string): TerminalStateSnapshot | undefined {
  return terminalState.get(paneId)
}

function primaryWindowId(): string | undefined {
  return [...windows.keys()][0]
}

let gwSubSeq = 0

export function attachPhoneObserver(
  rendererPaneId: string,
  opts: {
    sinceCursor?: number
    role?: 'observer' | 'owner'
    sendData: (data: string) => void
  },
): { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null {
  const entry = ptys.get(rendererPaneId)
  if (!entry) return null
  const id = `gw-${++gwSubSeq}`
  const role: SubscriberRole = opts.role === 'owner' ? 'owner' : 'observer'
  const { cursor, dropped } = entry.session.addSubscriber(
    { id, role, send: (data) => opts.sendData(data) },
    opts.sinceCursor ?? 0,
  )
  return {
    cursor,
    dropped,
    cols: entry.pty.cols,
    rows: entry.pty.rows,
    detach: () => entry.session.removeSubscriber(id),
  }
}

export function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
  try {
    ptys.get(rendererPaneId)?.pty.resize(cols || 80, rows || 24)
  } catch {}
}

export function ptyWrite(rendererPaneId: string, data: string): void {
  ptys.get(rendererPaneId)?.pty.write(data)
}

let reqSeq = 0

export function execCommand(
  target: CommandTarget,
  id: string,
  args?: unknown,
): Promise<CommandResult> {
  const win = target.windowId ? windows.get(target.windowId) : [...windows.values()][0]
  if (!win || win.isDestroyed()) {
    return Promise.resolve({
      ok: false,
      error: { code: 'command-failed', message: 'target window not available' },
    })
  }
  const reqId = `cmd-${++reqSeq}`
  return new Promise((resolve) => {
    const onResult = (_e: Electron.IpcMainEvent, rid: string, result: CommandResult): void => {
      if (rid !== reqId) return
      clearTimeout(timer)
      ipcMain.removeListener('command:result', onResult)
      resolve(result)
    }
    ipcMain.on('command:result', onResult)
    win.webContents.send('command:invoke', reqId, { id, args, target })
    const timer = setTimeout(() => {
      ipcMain.removeListener('command:result', onResult)
      resolve({ ok: false, error: { code: 'command-failed', message: 'command timed out' } })
    }, 5000)
  })
}

function sendToSessionWindow(
  sessionId: string | undefined,
  channel: string,
  payload: unknown,
): void {
  const windowId = sessionId ? windowOfSession(sessionId) : undefined
  const win = (windowId ? windows.get(windowId) : undefined) ?? [...windows.values()][0]
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function emitFocusChanged(): void {
  extensionHost?.emitEvent('focus.changed', { focused: BrowserWindow.getFocusedWindow() !== null })
}

app.whenReady().then(() => {
  loadRestoredScrollback()
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerLspIpc()
  const notifyDeps = {
    execCommand,
    windows: () => windows.values(),
    windowById: (id: string) => windows.get(id),
  }
  registerNotifyMethods(notifyDeps)
  registerNotifyIpc(notifyDeps)
  registerAttentionMethods({ execCommand })
  registerProcessMethods()
  registerDocsMethods({ extensions: () => extensionHost?.listForAgents() ?? [] })
  registerVaultMethods()
  registerBusMethods()
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  settingsSync = startSettingsSync({
    userData: app.getPath('userData'),
    broadcast: (channel, payload) => broadcast(channel, payload),
    onExtensionsPulled: () => {
      extensionStore.reload()
      extensionHost?.reloadRecords()
    },
  })
  settingsSync.run()
  extensionHost = new ExtensionHost({
    roots: extensionRoots(),
    store: extensionStore,
    socketPath: controlSocketPath,
    nodePath: process.execPath,
    workDirForSession,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    broadcast,
    openPanelIn: (req) => sendToSessionWindow(req.sessionId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToSessionWindow(req.sessionId, 'extensions:open-diff', req),
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
  })
  registerExtensionMethods(() => extensionHost)
  registerExtensionIpc(extensionHost)
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    extensionHost?.emitEvent('notification', n),
  )
  registerPaneListMethods({ execCommand, getTerminalState })
  registerGatewayMethods()
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () => listPanes({ execCommand, getTerminalState }),
    listSessions: () => listSessions({ execCommand }),
    invokeExtension: (extId, command, args, sessionId, capabilities) =>
      extensionHost
        ? extensionHost.invoke(extId, command, args, {
            kind: 'phone',
            sessionId,
            workDir: workDirForSession(sessionId),
            capabilities,
          })
        : Promise.resolve({ ok: false, error: 'no-extension-host' }),
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
  })
  registerBrowseMethods({
    browserPanes,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
  })
  registerPickMethods({ browserPanes, errorBuffers, broadcast })
  registerPickIpc({ browserPanes, errorBuffers, broadcast })
  registerControlServer({ execCommand, listCommandsFor, getTerminalState })
  createWindow()
  extensionHost.startEager()
  app.on('browser-window-focus', emitFocusChanged)
  app.on('browser-window-blur', emitFocusChanged)
  setInterval(autosaveScrollback, SCROLLBACK_AUTOSAVE_MS).unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function persistScrollback(): void {
  if (!restorePersistEnabled) return
  try {
    const byPane = pendingRestoredScrollback()
    for (const [paneId, entry] of ptys) byPane[paneId] = entry.session.since(0).data
    saveScrollback(byPane)
  } catch (err) {
    console.error('[session] scrollback save failed', err)
  }
}

const SCROLLBACK_AUTOSAVE_MS = 5000
let lastScrollbackSignature = ''

function autosaveScrollback(): void {
  let signature = ''
  for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.session.since(0).cursor};`
  signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
  if (signature === lastScrollbackSignature) return
  lastScrollbackSignature = signature
  persistScrollback()
}

app.on('before-quit', () => {
  persistScrollback()
  for (const entry of ptys.values()) {
    try {
      entry.pty.kill()
    } catch {}
  }
  ptys.clear()
  killAllLsp()
  killAllProcesses()
  extensionHost?.stopAll()
  settingsSync?.stop()
  stopControlServer()
  void stopGateway()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
