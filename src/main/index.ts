import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, screen, shell } from 'electron'
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
import { controlSocketPath, registerControlServer, stopControlServer } from './controlServer'
import { registerDocsMethods } from './docs'
import { registerPane, removePane, removeWindow } from './idRegistry'
import { killAllLsp, registerLspIpc } from './lsp'
import { registerNotifyMethods } from './notify'
import { resolveSafe } from './pathGuard'
import { PtySession } from './ptySession'
import { shellIntegrationSpawnOptions } from './shellIntegration'

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

  // Track this window for the command bridge; prune it (and its pane identities,
  // published commands) once it's gone.
  const wid = String(win.webContents.id)
  windows.set(wid, win)
  win.on('closed', () => {
    windows.delete(wid)
    commandsByWindow.delete(wid)
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
    } else if (event.type === 'session-activated' || event.type === 'session-added') {
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
  registerDocsMethods()
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
  stopControlServer()
})

app.on('window-all-closed', () => {
  // Standard desktop behavior; on macOS apps usually stay alive until Cmd+Q.
  if (process.platform !== 'darwin') app.quit()
})
