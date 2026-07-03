import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, screen, shell } from 'electron'
import type { IPty } from 'node-pty'
import type {
  AppInfo,
  FsEntry,
  PaneDescriptor,
  PtyAttachResult,
  PtySpawnOptions,
} from '../shared/types'
import { killAllLsp, registerLspIpc } from './lsp'
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
    const pty = mod.spawn(shell, integration.args, {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: resolveCwd(opts.cwd),
      env: { ...process.env, ...integration.env } as Record<string, string>,
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

/** Read-only filesystem access for the explorer. */
function registerFsIpc(): void {
  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] => {
    try {
      return readdirSync(expandHome(dir), { withFileTypes: true })
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:read', (_e, path: string): string | null => {
    try {
      return readFileSync(expandHome(path), 'utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:write', (_e, path: string, content: string): boolean => {
    try {
      writeFileSync(expandHome(path), content, 'utf8')
      return true
    } catch {
      return false
    }
  })
}

app.whenReady().then(() => {
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerLspIpc()
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
})

app.on('window-all-closed', () => {
  // Standard desktop behavior; on macOS apps usually stay alive until Cmd+Q.
  if (process.platform !== 'darwin') app.quit()
})
