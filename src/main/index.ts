import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, screen, shell, webContents } from 'electron'
import type { IPty } from 'node-pty'
import type {
  AppInfo,
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  FsEntry,
  LifecycleEvent,
  PaneDescriptor,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
} from '../shared/types'
import {
  type ConsoleEntry,
  PAGE_ERROR_CATCHER_JS,
  PINE_ERROR_PREFIX,
  clearGuestFrame,
  consoleLevelName,
  pushConsoleEntry,
  registerBrowseMethods,
} from './browse'
import { registerBusMethods } from './bus'
import { controlSocketPath, registerControlServer, stopControlServer } from './controlServer'
import { registerDocsMethods } from './docs'
import { registerGatewayMethods } from './gateway'
import { configureGatewayControl, stopGateway } from './gateway/server'
import { getByPaneId, registerPane, removePane, removeWindow } from './idRegistry'
import { kanbanGet, kanbanUpdate, registerKanbanIpc, registerKanbanMethods } from './kanban'
import { killAllLsp, registerLspIpc } from './lsp'
import { registerNotifyMethods } from './notify'
import { listPanes, listSessions, registerPaneListMethods } from './paneList'
import { resolveSafe } from './pathGuard'
import { killAllProcesses, registerProcessMethods } from './processManager'
import { PtySession, type SubscriberRole } from './ptySession'
import { removeSession, setSessionWorkDir } from './sessionRegistry'
import { shellIntegrationSpawnOptions } from './shellIntegration'
import { registerVaultMethods } from './vault'
import { registerWikiIpc, registerWikiMethods } from './wiki'

/** True when launched by `electron-vite dev` (renderer served from a dev URL). */
const devServerUrl = process.env.ELECTRON_RENDERER_URL

/**
 * node-pty is a native module — load it lazily and tolerate its absence so the app
 * still starts if it wasn't rebuilt for Electron's ABI (terminals just stay blank).
 */
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

/** A live pty keyed by pane id; output is buffered so a remounted terminal can replay it. */
interface PtyEntry {
  pty: IPty
  session: PtySession
  /** subscriber id (String(webContents.id)) → WebContents, for exit fan-out. */
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
}

const ptys = new Map<string, PtyEntry>()
/** Replayable output kept per pane (~1MB) and the grace before a detached pty is killed. */
const PTY_BUFFER_CAP = 1_000_000
const DETACH_GRACE_MS = 3000

function killPty(paneId: string): void {
  const entry = ptys.get(paneId)
  if (!entry) return
  if (entry.killTimer) clearTimeout(entry.killTimer)
  try {
    entry.pty.kill()
  } catch {
    // already gone
  }
  ptys.delete(paneId)
}

/** Expand a leading `~` to the home directory. */
function expandHome(p: string): string {
  const home = homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/** Expand `~`, and fall back to the home dir when the path doesn't exist (seed cwds are mock). */
function resolveCwd(cwd?: string): string {
  const home = homedir()
  const p = expandHome(cwd ?? home)
  try {
    if (statSync(p).isDirectory()) return p
  } catch {
    // non-existent path → home
  }
  return home
}

/** Descriptors for torn-off pane windows, keyed by webContents id. */
const detachedPanes = new Map<number, PaneDescriptor>()

/**
 * Live windows keyed by `String(webContents.id)` — the same "windowId" used by
 * `idRegistry.ts` and `lifecycle:event`. Lets the command bridge (Slice 6) route
 * an explicit-target invocation to the right renderer.
 */
const windows = new Map<string, BrowserWindow>()
/** Each window's published command descriptors (renderer → main via `commands:register`). */
const commandsByWindow = new Map<string, CommandDescriptor[]>()

/**
 * A `browser` pane's live guest `<webview>` webContents id, keyed by renderer paneId —
 * registered on the webview's `dom-ready` (`browser:register` IPC) so main can drive it
 * (Stage 2 `browse.*` control methods, `src/main/browse.ts`). The guest is its own OS
 * process; this id is the only handle main has into it.
 */
const browserPanes = new Map<string, number>()

/**
 * `browse.console`/`browse.errors`' backing store — per-guest-webContents-id ring buffers,
 * populated by the `console-message` listener attached below (`browser:register`). `errorBuffers`
 * only ever receives the error-level / `[pine-error]`-tagged subset of what lands in
 * `consoleBuffers`. Both are pruned alongside `browserPanes` on `browser:unregister`/window close.
 */
const consoleBuffers = new Map<number, ConsoleEntry[]>()
const errorBuffers = new Map<number, ConsoleEntry[]>()

/**
 * Slice 7 read-model: each pane's latest terminal-state snapshot (cwd, running,
 * block count, last exit code), mirrored from the renderer's blocksStore/layoutStore
 * via `terminal:state` IPC (`src/renderer/commands/terminalStateBridge.ts`). Replace
 * semantics — a snapshot only overwrites the cache when its `generation` is >= the
 * cached one, so a stale pre-reset snapshot racing behind a fresh one is dropped.
 */
const terminalState = new Map<string, TerminalStateSnapshot>()

/**
 * OS-native window framing, VSCode-style:
 * - macOS keeps the native traffic lights (left), but hides the title bar so our
 *   chrome reaches the top edge. We nudge the lights to sit centered in our bar.
 * - Windows/Linux go fully frameless; the renderer draws min/max/close on the right.
 */
function frameOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
  }
  return { frame: false }
}

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    // Security baseline (see docs/ARCHITECTURE.md §3): renderer has no Node access.
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // Required for the `browser` surface's <webview> tag. The guest page it loads runs in
    // its own isolated process (a separate partition) — this only lets Pine's renderer USE
    // <webview>; it does not relax the guest's own sandbox (no nodeIntegration on the guest).
    webviewTag: true,
  }
}

/** Shared per-window wiring: show when ready, report maximize state, externalize links. */
function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => win.show())

  const emitMaximized = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Guard against a compromised renderer weaponizing the `webviewTag: true` baseline: force-
  // sanitize every attaching `<webview>` guest's preferences regardless of what the renderer
  // asked for, so even a hostile renderer can't hand a guest page a preload script or turn
  // node integration / context isolation / the sandbox off. This is defense-in-depth on top of
  // `browser:register`'s ownership check below — it protects the HOST process even if the
  // renderer itself is compromised.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!params.partition?.startsWith('pine-browser')) {
      event.preventDefault()
      return
    }
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })

  // Track this window for the command bridge; prune it (and its pane identities,
  // published commands) once it's gone.
  const wid = String(win.webContents.id)
  windows.set(wid, win)
  win.on('closed', () => {
    windows.delete(wid)
    commandsByWindow.delete(wid)
    // Ghost-reap browser panes BEFORE removeWindow() below drops their idRegistry entries —
    // `getByPaneId` would otherwise return nothing for them afterward and these stale
    // renderer-paneId → webContents-id entries would never be pruned. Covers the same
    // force-close/crash case as the pty reap: BrowserView's unmount (and its
    // `browser:unregister` call) never fires.
    for (const [paneId, wcId] of browserPanes) {
      if (getByPaneId(paneId)?.windowId === wid) {
        browserPanes.delete(paneId)
        consoleBuffers.delete(wcId)
        errorBuffers.delete(wcId)
        clearGuestFrame(wcId)
      }
    }
    removeWindow(wid)
    // Ghost-owner reap: a window can close without `pty:detach` firing (force-close,
    // crash, OS kill). Its pty subscriber (keyed by this same wid, per `pty:attach`)
    // would otherwise linger forever — ownerCount never hits 0, onNoOwners never
    // fires, and the pty leaks. Prune it from every pane this window subscribed to.
    for (const entry of ptys.values()) {
      if (entry.subs.has(wid)) {
        entry.subs.delete(wid)
        entry.session.removeSubscriber(wid) // last owner leaving fires onNoOwners → grace kill
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
    title: 'pine',
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

/** A new window hosting a single torn-off pane, positioned under the drop point. */
function createDetachedWindow(descriptor: PaneDescriptor, point: { x: number; y: number }): void {
  const win = new BrowserWindow({
    width: 680,
    height: 460,
    minWidth: 360,
    minHeight: 220,
    x: Math.round(point.x - 56),
    y: Math.round(point.y - 14),
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    title: descriptor.title,
    ...frameOptions(),
    webPreferences: baseWebPreferences(),
  })

  const id = win.webContents.id
  detachedPanes.set(id, descriptor)
  win.on('closed', () => detachedPanes.delete(id))

  wireWindow(win)

  if (devServerUrl) {
    win.loadURL(`${devServerUrl}?detached=1`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'detached=1' })
  }
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => 'pong' as const)
  // The user-editable settings file (open it in the editor / back the settings store).
  ipcMain.handle('settings:path', () => join(app.getPath('userData'), 'settings.json'))
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: 'pine',
      version: app.getVersion(),
      platform: process.platform,
    }),
  )

  // Custom window controls (frameless Win/Linux; available everywhere for symmetry).
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

  // Tear-off: spawn a new window only if the pane was released OUTSIDE this window.
  // We trust the OS cursor position, not the (flaky) drag-event coordinates.
  ipcMain.handle('window:tear-off', (e, descriptor: PaneDescriptor) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { detached: false }
    const cursor = screen.getCursorScreenPoint()
    const b = win.getBounds()
    const inside =
      cursor.x >= b.x && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height
    if (inside) return { detached: false }
    createDetachedWindow(descriptor, cursor)
    return { detached: true }
  })

  ipcMain.handle(
    'window:get-detached-pane',
    (e): PaneDescriptor | null => detachedPanes.get(e.sender.id) ?? null,
  )

  // UI lifecycle → pane id/token registry (main/idRegistry.ts). windowId is tagged here
  // (not trusted from the renderer) since webContents.id is only known to main.
  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    if (event.type === 'pane-created') {
      registerPane({ windowId, sessionId: event.sessionId, paneId: event.paneId })
    } else if (event.type === 'pane-closed') {
      removePane(event.paneId)
      terminalState.delete(event.paneId)
    } else if (event.type === 'session-added') {
      setSessionWorkDir(event.sessionId, event.workDir)
    } else if (event.type === 'session-closed') {
      removeSession(event.sessionId)
    } else if (event.type === 'session-activated') {
      // Session-scoped bookkeeping hook; panes already carry sessionId at creation.
    }
  })

  // Command bridge (Slice 6): each window publishes its command registry on load so
  // main (and, via listCommandsFor, the control socket / `pine` CLI) can discover it.
  ipcMain.on('commands:register', (e, descriptors: CommandDescriptor[]) => {
    commandsByWindow.set(String(e.sender.id), descriptors)
  })

  // Terminal-state mirror (Slice 7): replace-on-newer-or-equal-generation so a stale
  // pre-reset snapshot racing behind a fresh post-reset one never clobbers it.
  ipcMain.on('terminal:state', (_e, snapshot: TerminalStateSnapshot) => {
    const cur = terminalState.get(snapshot.paneId)
    if (!cur || snapshot.generation >= cur.generation) terminalState.set(snapshot.paneId, snapshot)
  })

  // Browser-pane registration (Stage 2): the renderer hands over a `browser` pane's guest
  // webContents id once the `<webview>` fires `dom-ready` — main can't get this any other
  // way (the guest is a separate OS process it doesn't otherwise see). Consumed by
  // `browse.*` control methods (`src/main/browse.ts`) via the injected `browserPanes` map.
  ipcMain.on('browser:register', (e, paneId: string, webContentsId: number) => {
    // Don't trust the renderer's claim at face value — a compromised renderer could register
    // an arbitrary webContents id (e.g. Pine's OWN renderer wc) and then drive it via
    // `browse.eval`. Verify (a) the sender actually owns this pane, and (b) the wc it's
    // vouching for is genuinely a `<webview>` guest attached to that same sender, before
    // trusting the mapping.
    const wid = String(e.sender.id)
    if (getByPaneId(paneId)?.windowId !== wid) return
    const gc = webContents.fromId(webContentsId)
    if (!gc || gc.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
    browserPanes.set(paneId, webContentsId)
    // Console/error capture (`browse.console`/`browse.errors`): attach once per guest webContents
    // — `dom-ready` (and thus this whole handler) refires on every navigation of the SAME
    // long-lived webview, so guard on an already-attached listener rather than accumulating one
    // per navigation.
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
      // Uncaught-error catcher: same CDP mechanism `browse.addinitscript` exposes to callers
      // (`Page.addScriptToEvaluateOnNewDocument`), applied automatically here so `browse.errors`
      // sees crashes even on a page nobody explicitly instrumented. Best-effort — a human already
      // having DevTools open on this pane (Chrome allows only one CDP consumer) makes this fail
      // silently; explicit `console.*` capture above still works either way.
      try {
        if (!gc.debugger.isAttached()) gc.debugger.attach('1.3')
        gc.debugger
          .sendCommand('Page.enable')
          .then(() =>
            gc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
              source: PAGE_ERROR_CATCHER_JS,
            }),
          )
          .catch(() => {
            // best-effort, see above
          })
      } catch {
        // `debugger.attach()` can throw synchronously (e.g. a race with a human-opened DevTools
        // session) — non-fatal.
      }
    }
  })
  ipcMain.on('browser:unregister', (_e, paneId: string) => {
    const wcId = browserPanes.get(paneId)
    browserPanes.delete(paneId)
    if (wcId !== undefined) {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestFrame(wcId)
    }
  })
}

/**
 * Pseudo-terminal streaming, keyed by pane id. The pty + a capped output buffer live in
 * main, so the terminal survives the pane remounting (split/relocate): `attach` re-binds
 * the renderer and replays the buffer; `detach` keeps it alive briefly, then kills it.
 */
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

    // Re-attach to an existing pty (remount) — cancel any pending kill, replay the buffer.
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
        buffer: '\r\n\x1b[38;2;239;89;111m node-pty unavailable — run: npm run rebuild\x1b[0m\r\n',
        cursor: 0,
        dropped: false,
      }
    }
    const shell =
      opts.shell ?? process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
    // zsh/bash get shell-integration hooks injected (OSC 133 blocks + OSC 7 cwd, parsed by
    // Terminal.tsx); anything else spawns as-is with no integration, degrading gracefully.
    const integration = shellIntegrationSpawnOptions(shell, process.env)
    // Mint (or reuse, if a `pane-created` lifecycle event already registered it) this
    // pane's external identity, and hand the pty a token that proves only this pane
    // (pane-scoped-trust posture) for the Slice 4 control socket to authenticate against.
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
      } as Record<string, string>,
    })
    const session = new PtySession({
      capBytes: PTY_BUFFER_CAP,
      onNoOwners: () => {
        const en = ptys.get(paneId)
        if (en && !en.killTimer) en.killTimer = setTimeout(() => killPty(paneId), DETACH_GRACE_MS)
      },
      onExit: (code) => {
        const en = ptys.get(paneId)
        if (en) {
          for (const wc of en.subs.values()) {
            if (!wc.isDestroyed()) wc.send(`pty:exit:${paneId}`, code)
          }
        }
        ptys.delete(paneId)
      },
    })
    const entry: PtyEntry = { pty, session, subs: new Map([[subId, e.sender]]), killTimer: null }
    ptys.set(paneId, entry)

    pty.onData((d) => session.push(d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    session.addLiveSubscriber(mkSub())
    const { cursor, dropped } = session.since(0)
    return { created: true, buffer: '', cursor, dropped }
  })

  ipcMain.on('pty:detach', (e, paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return
    const subId = String(e.sender.id)
    entry.subs.delete(subId)
    entry.session.removeSubscriber(subId) // last owner leaving fires onNoOwners → starts the grace kill
  })

  ipcMain.on('pty:write', (e, paneId: string, data: string) => {
    const entry = ptys.get(paneId)
    if (entry?.session.canWrite(String(e.sender.id))) entry.pty.write(data)
  })
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) => {
    try {
      ptys.get(paneId)?.pty.resize(cols || 80, rows || 24)
    } catch {
      // resize can throw mid-teardown; ignore
    }
  })
  ipcMain.on('pty:kill', (_e, paneId: string) => killPty(paneId))
}

/** Filesystem access for the explorer + editor, confined to an allow-list of roots. */
function registerFsIpc(): void {
  // Contain fs:* to the user's home + the app's userData dir (which holds settings.json and is
  // normally under home anyway). This closes the path-traversal hole — a renderer/compromised
  // extension can no longer read /etc/passwd or escape via ../ through these handlers (see
  // src/main/pathGuard.ts + CLAUDE.md §8). The terminal (node-pty) is unaffected: it can still
  // run anywhere; only the explorer/editor's file reads/writes are contained. Rejected paths
  // degrade to the same empty/null/false results as any other fs error. To browse outside home,
  // add roots here.
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

/** The command descriptors a window has published, for `pine commands` (Slice 6 T2). */
export function listCommandsFor(windowId: string): CommandDescriptor[] {
  return commandsByWindow.get(windowId) ?? []
}

/** The latest mirrored terminal-state snapshot for `paneId`, if any (Slice 7). */
export function getTerminalState(paneId: string): TerminalStateSnapshot | undefined {
  return terminalState.get(paneId)
}

/**
 * "The primary window" for callers with no window of their own to act as (the LAN gateway's
 * phone-facing `command.list`/`command.exec`, Phase C batch 2) — the first live window, same as
 * `execCommand`'s own no-`windowId` fallback below, so the two stay consistent with each other.
 */
function primaryWindowId(): string | undefined {
  return [...windows.keys()][0]
}

let gwSubSeq = 0

/**
 * Register a paired phone as a subscriber on a pane's live `PtySession` (Phase C batch 3, LAN
 * gateway PTY streaming, contract §6) — the gateway-facing counterpart to `registerPtyIpc`'s
 * `pty:attach` IPC handler above, reusing the exact same multi-subscriber `PtySession` (no
 * separate buffering/replay path for phones). `rendererPaneId` is main's INTERNAL pane id (the
 * gateway resolves the phone's external id via `idRegistry` before calling this); returns null
 * if there's no live pty for it (unknown/closed pane — `server.ts` turns that into an
 * invalid-params error). `role:'owner'` is honored as requested — gating "owner needs the
 * device's `input` cap" is the caller's (`server.ts`'s) job, same as `pty:attach`'s IPC
 * counterpart trusts its caller's `opts.role`. The returned `detach` lets the caller
 * (`server.ts`) drop the subscription on `pty.detach` or WS close, mirroring
 * `ipcMain.on('pty:detach', ...)`'s `removeSubscriber` below.
 */
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

/** Resize a pane's pty (SIGWINCH) — the gateway's counterpart to `ipcMain.on('pty:resize', ...)`
 *  above, called from `server.ts`'s binary `0x03` resize-frame handler. No-op if the pane has no
 *  live pty (already detached/closed) or mid-teardown. */
export function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
  try {
    ptys.get(rendererPaneId)?.pty.resize(cols || 80, rows || 24)
  } catch {
    // resize can throw mid-teardown; ignore
  }
}

/** Write input bytes into a pane's pty — the gateway's counterpart to `ipcMain.on('pty:write',
 *  ...)` above, called from `server.ts`'s binary `0x02` input-frame handler ONLY once the caller
 *  has confirmed the socket is attached as `owner` (this helper itself does no cap/role check,
 *  same posture as `ptyResize`). No-op if the pane has no live pty. */
export function ptyWrite(rendererPaneId: string, data: string): void {
  ptys.get(rendererPaneId)?.pty.write(data)
}

let reqSeq = 0

/**
 * Ask a window's renderer to execute a command against an explicit target, over the
 * `command:invoke` / `command:result` IPC round-trip the preload bridge wires up
 * (`wireCommandBridge` in the renderer). Used by the control socket / `pine` CLI
 * (Slice 6 T2) — not yet called from anywhere else, so this is passive today.
 */
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
      ipcMain.removeListener('command:result', onResult)
      resolve(result)
    }
    ipcMain.on('command:result', onResult)
    win.webContents.send('command:invoke', reqId, { id, args, target })
    // Safety timeout so a dead/unresponsive renderer doesn't hang the caller forever.
    setTimeout(() => {
      ipcMain.removeListener('command:result', onResult)
      resolve({ ok: false, error: { code: 'command-failed', message: 'command timed out' } })
    }, 5000)
  })
}

app.whenReady().then(() => {
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerLspIpc()
  registerNotifyMethods()
  registerProcessMethods()
  registerDocsMethods()
  registerVaultMethods()
  registerWikiMethods()
  registerKanbanMethods()
  // The renderer's own data bridges for the Kanban/Wiki surface panes — separate from the
  // `kanban.*`/`wiki.*` control-socket methods above (those serve the CLI/agents over the
  // control socket; these serve `window.pine.kanban`/`window.pine.wiki` directly). Both sides
  // share the same read/write core (see `kanban.ts`/`wiki.ts`'s `*At` helpers).
  registerKanbanIpc()
  registerWikiIpc()
  registerBusMethods()
  // `pane.list`/`session.list` on the local control socket (Phase C batch 2) — the renderer owns
  // pane kinds/titles + session names; this maps internal paneIds to `idRegistry` EXTERNAL ids.
  registerPaneListMethods({ execCommand, getTerminalState })
  // The LAN control gateway is OFF BY DEFAULT (contract §0) — this only registers the
  // `gateway.*` control-socket methods (enable/disable/pair/status/devices/revoke); nothing
  // actually starts listening until a caller explicitly invokes `gateway.enable`.
  registerGatewayMethods()
  // The gateway's phone-facing control API (batch 2, `gateway/controlDispatch.ts`) needs the
  // same deps as the local control socket, plus the workspace-wide `listPanes`/`listSessions`
  // reads and the kanban board — wired regardless of whether the gateway is actually running
  // (it's OFF by default; these are just the deps it'll use once enabled). `attachPhoneObserver`/
  // `ptyResize`/`ptyWrite` (batch 3, contract §6) are called directly by `gateway/server.ts`'s
  // socket handling, not through `dispatchGatewayMethod` — see `GatewayControlDeps`'s docstring.
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () => listPanes({ execCommand, getTerminalState }),
    listSessions: () => listSessions({ execCommand }),
    kanbanGet,
    kanbanUpdate,
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
  })
  // Same allow-list as `fs:*` (see `registerFsIpc`) — `browse.screenshot`'s caller-supplied
  // `path` gets the same containment, closing the arbitrary-write hole a bare `writeFileSync`
  // would otherwise open.
  registerBrowseMethods({
    browserPanes,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
  })
  registerControlServer({ execCommand, listCommandsFor, getTerminalState })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const entry of ptys.values()) {
    try {
      entry.pty.kill()
    } catch {
      // already gone
    }
  }
  ptys.clear()
  killAllLsp()
  killAllProcesses()
  stopControlServer()
  void stopGateway()
})

app.on('window-all-closed', () => {
  // Standard desktop behavior; on macOS apps usually stay alive until Cmd+Q.
  if (process.platform !== 'darwin') app.quit()
})
