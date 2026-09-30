import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, nativeTheme, session, shell, webContents } from 'electron'
import type { IPty } from 'node-pty'
import appIcon from '../../resources/icon.png?asset'
import type { ExtensionResult } from '../shared/extensions'
import { PRODUCT_NAME } from '../shared/product'
import type {
  AppInfo,
  AppSnapshot,
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  ExternalEditorRequest,
  FsEntry,
  FsKind,
  LifecycleEvent,
  PromptContext,
  PromptContextRequest,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
} from '../shared/types'
import { clampZoom, zoomFactor } from '../shared/zoom'
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
import { confirmAllWindowsClose, confirmWindowClose, registerCloseGuard } from './closeGuard'
import { controlSocketPath, registerControlServer, stopControlServer } from './controlServer'
import { registerDocsMethods } from './docs'
import { emitPlatformEvent, emitSessionState, platformEvents } from './events'
import { confirmForExtension } from './extensionConfirm'
import { ExtensionHost, type TerminalOpenRequest, registerExtensionMethods } from './extensionHost'
import type { ExtensionRoot } from './extensionManifest'
import { ExtensionStore } from './extensionStore'
import { openInExternalEditor } from './externalEditor'
import { readBinaryConfined } from './fsBinary'
import { registerGatewayIpc, registerGatewayMethods } from './gateway'
import { configureGatewayControl, stopGateway } from './gateway/server'
import { clearGuestNetwork, watchGuestNetwork } from './guestNetwork'
import {
  getByPaneId,
  registerPane,
  removePane,
  removeWindow,
  windowOfWorkspace,
} from './idRegistry'
import { killAllLsp, registerLspIpc } from './lsp'
import {
  postNotification,
  postPanelNotification,
  registerNotifyIpc,
  registerNotifyMethods,
} from './notify'
import { listPanes, listWorkspaces, registerPaneListMethods } from './paneList'
import { registerPaneResumeMethods } from './paneResume'
import { resolveSafe } from './pathGuard'
import { privateTmpDir } from './privateTmp'
import { killAllProcesses, registerProcessMethods } from './processManager'
import { KubeContextReader, NodeVersionResolver, promptContext } from './promptContext'
import { PtySession, type SubscriberRole } from './ptySession'
import { ScreenMirror } from './screenMirror'
import { registerSelectionIpc } from './selectionReport'
import { type SettingsSyncHandle, startSettingsSync } from './settingsSyncIpc'
import { ExecutableIndex, commandNames, readShellState } from './shellCommands'
import { shellIntegrationSpawnOptions } from './shellIntegration'
import { registerVaultMethods } from './vault'
import { removeWorkspace, setWorkspaceWorkDir, workDirForWorkspace } from './workspaceRegistry'
import {
  clearPersisted,
  dropRestoredScrollback,
  loadRestoredScrollback,
  loadSnapshot,
  parseSnapshot,
  pendingRestoredScrollback,
  saveScrollback,
  saveSnapshot,
  stashScrollback,
  takeRestoredScrollback,
} from './workspaceSnapshot'

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
  mirror: ScreenMirror
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
}

const ptys = new Map<string, PtyEntry>()
const PTY_BUFFER_CAP = 1_000_000
const DETACH_GRACE_MS = 3000
const executables = new ExecutableIndex()
const promptSources = { node: new NodeVersionResolver(), kube: new KubeContextReader() }

function removeStateFile(entry: PtyEntry): void {
  rmSync(entry.stateFile, { force: true })
}

let restorePersistEnabled = true

const RESTORE_SEAM = '\x1b]133;D\x07\r\n\x1b[2m── workspace restored ──\x1b[0m\r\n'
const HIBERNATE_SEAM = '\x1b]133;D\x07\r\n\x1b[2m── woke from hibernation ──\x1b[0m\r\n'

const hibernatedPanes = new Set<string>()

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
  entry.mirror.dispose()
  removeStateFile(entry)
  ptys.delete(paneId)
}

function hibernatePty(paneId: string): boolean {
  const entry = ptys.get(paneId)
  if (!entry) return false
  stashScrollback(paneId, entry.mirror.serialize())
  hibernatedPanes.add(paneId)
  entry.subs.clear()
  killPty(paneId)
  terminalState.delete(paneId)
  return true
}

function ptyPid(paneId: string): number | undefined {
  return ptys.get(paneId)?.pty.pid
}

function feedPty(entry: PtyEntry, data: string): void {
  entry.session.push(data)
  entry.mirror.write(data)
}

function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
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

const instrumentedGuests = new WeakSet<Electron.WebContents>()

function instrumentBrowserGuest(gc: Electron.WebContents): void {
  const wcId = gc.id
  if (!instrumentedGuests.has(gc)) {
    instrumentedGuests.add(gc)
    gc.on('console-message', (_event, level, message) => {
      const entry: ConsoleEntry = {
        level: consoleLevelName(level),
        text: message,
        ts: Date.now(),
      }
      pushConsoleEntry(consoleBuffers, wcId, entry)
      if (entry.level === 'error' || message.startsWith(PINE_ERROR_PREFIX)) {
        pushConsoleEntry(errorBuffers, wcId, entry)
      }
    })
  }
  if (!gc.debugger.isAttached()) {
    try {
      gc.debugger.attach('1.3')
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
}

function hardenExtensionGuest(guest: Electron.WebContents): boolean {
  const host = extensionHost
  if (!host) return false
  const extId = host
    .panelExtensionIds()
    .find((id) => guest.session === session.fromPartition(`${EXTENSION_PARTITION_PREFIX}${id}`))
  if (!extId) return false
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
  return true
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

let quitApproved = false
let quitAsking = false
const approvedWindows = new WeakSet<BrowserWindow>()

function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => win.show())

  win.on('close', (event) => {
    if (quitApproved || approvedWindows.has(win)) return
    event.preventDefault()
    void confirmWindowClose(win).then((approved) => {
      if (!approved || win.isDestroyed()) return
      approvedWindows.add(win)
      win.close()
    })
  })

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
  win.webContents.on('did-attach-webview', (_e, guest) => {
    if (hardenExtensionGuest(guest)) return
    instrumentBrowserGuest(guest)
    const wcId = guest.id
    guest.once('destroyed', () => {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
    })
  })

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
    backgroundColor: '#1d2022',
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    icon: appIcon,
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

  ipcMain.on('workspace:save', (_e, snapshot: AppSnapshot | null) => {
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
      console.error('[workspace] snapshot save failed', err)
    }
  })
  ipcMain.handle('workspace:load', (): AppSnapshot | null => {
    try {
      return loadSnapshot()
    } catch (err) {
      console.error('[workspace] snapshot load failed', err)
      return null
    }
  })

  registerCloseGuard()
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('window:system-dark', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window:system-dark-changed', nativeTheme.shouldUseDarkColors)
      }
    }
  })
  ipcMain.handle('window:set-zoom', (e, percent: unknown) => {
    const clamped = clampZoom(percent)
    e.sender.setZoomFactor(zoomFactor(clamped))
    return clamped
  })
  ipcMain.handle(
    'window:is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  )

  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    if (event.type === 'pane-created') {
      const identity = registerPane({
        windowId,
        workspaceId: event.workspaceId,
        paneId: event.paneId,
      })
      extensionHost?.emitEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: event.workspaceId,
      })
    } else if (event.type === 'pane-closed') {
      const identity = getByPaneId(event.paneId)
      if (identity) {
        dropIdentity(identity.externalId)
        extensionHost?.emitEvent('pane.closed', {
          paneId: identity.externalId,
          workspaceId: event.workspaceId,
        })
      }
      dropRestoredScrollback(event.paneId)
      hibernatedPanes.delete(event.paneId)
      removePane(event.paneId)
      terminalState.delete(event.paneId)
    } else if (event.type === 'workspace-added') {
      setWorkspaceWorkDir(event.workspaceId, event.workDir)
    } else if (event.type === 'workspace-closed') {
      removeWorkspace(event.workspaceId)
    } else if (event.type === 'workspace-activated') {
    } else if (event.type === 'workspace-state') {
      emitSessionState(event.workspaceId, event.state)
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
          emitTerminalExtensionEvents(identity.externalId, identity.workspaceId, cur, snapshot)
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
    instrumentBrowserGuest(gc)
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
  workspaceId: string,
  prev: TerminalStateSnapshot | undefined,
  next: TerminalStateSnapshot,
): void {
  const host = extensionHost
  if (!host) return
  if (next.cwd && prev?.cwd !== next.cwd) {
    host.emitEvent('cwd.changed', { paneId, workspaceId, cwd: next.cwd })
  }
  if (next.running && !prev?.running) {
    host.emitEvent('command.started', { paneId, workspaceId, cwd: next.cwd })
  } else if (!next.running && prev?.running) {
    host.emitEvent('command.finished', {
      paneId,
      workspaceId,
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
      target: { workspaceId: string | null; paneId: string | null },
    ): Promise<ExtensionResult> => {
      const paneId = target?.paneId ? getByPaneId(target.paneId)?.externalId : undefined
      const cwd = target?.paneId ? terminalState.get(target.paneId)?.cwd : undefined
      const caller = host.userCaller(target?.workspaceId ?? null, {
        capabilities: host.commandCapabilities(extId, command),
        ...(paneId ? { paneId } : {}),
        ...(cwd ? { cwd } : {}),
      })
      return host.invoke(extId, command, null, caller)
    },
  )
  ipcMain.handle(
    'extensions:panel',
    (_e, extId: string, context: { workspaceId: string; locale: string }) =>
      host.resolvePanel(String(extId), {
        workspaceId: String(context?.workspaceId ?? ''),
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
    const integration = shellIntegrationSpawnOptions(shell, process.env, opts.pinePrompt ?? null)
    const identity = registerPane({ windowId: subId, workspaceId: '', paneId })
    const cols = opts.cols || 80
    const rows = opts.rows || 24
    const stateFile = join(privateTmpDir('pine-shell-state'), randomUUID())
    const env = {
      ...process.env,
      ...integration.env,
      PINE_PANE_ID: identity.externalId,
      PINE_TOKEN: identity.token,
      PINE_START_DIR: opts.cwd ?? '',
      PINE_SOCKET: controlSocketPath(),
      PINE_CLI: join(app.getAppPath(), 'out/cli/index.js'),
      PINE_NODE: process.execPath,
      PINE_SHELL_STATE: stateFile,
    } as Record<string, string>
    const pty = mod.spawn(shell, integration.args, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: resolveCwd(opts.cwd),
      env,
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
        entry.mirror.dispose()
        removeStateFile(entry)
        if (ptys.get(paneId) === entry) ptys.delete(paneId)
      },
    })
    const entry: PtyEntry = {
      pty,
      session,
      mirror: new ScreenMirror(cols, rows),
      subs: new Map([[subId, e.sender]]),
      killTimer: null,
      spawnPath: env.PATH ?? '',
      stateFile,
    }
    ptys.set(paneId, entry)

    const history = takeRestoredScrollback(paneId)
    const seam = hibernatedPanes.delete(paneId) ? HIBERNATE_SEAM : RESTORE_SEAM
    if (history) feedPty(entry, `${history}${seam}`)

    pty.onData((d) => feedPty(entry, d))
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

  ipcMain.handle('pty:hibernate', (_e, paneId: string): boolean => hibernatePty(String(paneId)))

  ipcMain.on('pty:write', (e, paneId: string, data: string) => {
    const entry = ptys.get(paneId)
    if (entry?.session.canWrite(String(e.sender.id))) entry.pty.write(data)
  })
  ipcMain.handle('pty:commands', async (e, paneId: string): Promise<string[]> => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return []
    const state = await readShellState(entry.stateFile)
    return commandNames(executables, state?.path ?? entry.spawnPath, state?.names ?? [])
  })
  ipcMain.handle(
    'pty:prompt-context',
    async (e, paneId: string, want: PromptContextRequest): Promise<PromptContext | null> => {
      const entry = ptys.get(paneId)
      if (!entry?.subs.has(String(e.sender.id))) return null
      const state = await readShellState(entry.stateFile)
      return promptContext(
        state,
        entry.spawnPath,
        terminalState.get(paneId)?.cwd,
        { node: want?.node === true, kube: want?.kube === true },
        promptSources,
      )
    },
  )
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) => {
    resizePty(ptys.get(paneId), cols, rows)
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

  ipcMain.handle('fs:stat', (_e, path: string): FsKind | null => {
    const safe = resolveSafe(path, allowedRoots)
    if (safe === null) return null
    try {
      const stat = statSync(safe)
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
    } catch {
      return null
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

  ipcMain.handle('fs:read-binary', (_e, path: unknown) => readBinaryConfined(path, allowedRoots))

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
  resizePty(ptys.get(rendererPaneId), cols, rows)
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

function sendToWorkspaceWindow(
  workspaceId: string | undefined,
  channel: string,
  payload: unknown,
): void {
  const windowId = workspaceId ? windowOfWorkspace(workspaceId) : undefined
  const win = (windowId ? windows.get(windowId) : undefined) ?? [...windows.values()][0]
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function readLocale(): string | undefined {
  try {
    const settings = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    ) as { locale?: unknown }
    return typeof settings.locale === 'string' ? settings.locale : undefined
  } catch {
    return undefined
  }
}

const OPEN_TERMINAL_TIMEOUT_MS = 5000
let openTerminalSeq = 0

function openTerminalInWindow(req: TerminalOpenRequest): Promise<string | null> {
  const { windowId: requestedWindow, ...payload } = req
  const windowId =
    requestedWindow ?? (req.workspaceId ? windowOfWorkspace(req.workspaceId) : undefined)
  const win = (windowId ? windows.get(windowId) : undefined) ?? [...windows.values()][0]
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const wid = String(win.webContents.id)
  const requestId = `term-${++openTerminalSeq}`
  return new Promise((resolve) => {
    const finish = (paneId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('extensions:open-terminal-result', onResult)
      resolve(paneId)
    }
    const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
      if (rid !== requestId || String(e.sender.id) !== wid) return
      finish(
        typeof paneId === 'string' && paneId
          ? registerPane({ windowId: wid, workspaceId: '', paneId }).externalId
          : null,
      )
    }
    const timer = setTimeout(() => finish(null), OPEN_TERMINAL_TIMEOUT_MS)
    ipcMain.on('extensions:open-terminal-result', onResult)
    win.webContents.send('extensions:open-terminal', { ...payload, requestId })
  })
}

function emitFocusChanged(): void {
  extensionHost?.emitEvent('focus.changed', { focused: BrowserWindow.getFocusedWindow() !== null })
}

app.whenReady().then(() => {
  loadRestoredScrollback()
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerSelectionIpc()
  registerLspIpc()
  const notifyDeps = {
    execCommand,
    windows: () => windows.values(),
    windowById: (id: string) => windows.get(id),
  }
  registerNotifyMethods(notifyDeps)
  registerNotifyIpc(notifyDeps)
  registerAttentionMethods({ execCommand })
  registerPaneResumeMethods({ execCommand })
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
    workDirForWorkspace,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    locale: readLocale,
    broadcast,
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openTerminalIn: openTerminalInWindow,
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
  })
  registerExtensionMethods(() => extensionHost)
  registerExtensionIpc(extensionHost)
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    extensionHost?.emitEvent('notification', n),
  )
  registerPaneListMethods({ execCommand, getTerminalState, ptyPid })
  registerGatewayMethods()
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () => listPanes({ execCommand, getTerminalState, ptyPid }),
    listWorkspaces: () => listWorkspaces({ execCommand }),
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
    for (const [paneId, entry] of ptys) byPane[paneId] = entry.mirror.serialize()
    saveScrollback(byPane)
  } catch (err) {
    console.error('[workspace] scrollback save failed', err)
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

app.on('before-quit', (event) => {
  if (!quitApproved) {
    event.preventDefault()
    if (quitAsking) return
    quitAsking = true
    void confirmAllWindowsClose(BrowserWindow.getAllWindows()).then((approved) => {
      quitAsking = false
      if (!approved) return
      quitApproved = true
      app.quit()
    })
    return
  }
  persistScrollback()
  for (const entry of ptys.values()) {
    try {
      entry.pty.kill()
    } catch {}
    entry.mirror.dispose()
    removeStateFile(entry)
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
