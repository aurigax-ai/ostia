/**
 * Types shared across main, preload, and renderer.
 * Keep this dependency-free so every process can import it.
 */

import type { Capability } from './capabilities'

/** OS platform string (matches Node's `process.platform` values). */
export type Platform = 'darwin' | 'linux' | 'win32' | (string & {})

/** Minimal app metadata exposed to the renderer at startup. */
export interface AppInfo {
  name: string
  version: string
  platform: Platform
}

/** Minimal data to recreate a pane in a torn-off window. */
export interface PaneDescriptor {
  id: string
  title: string
}

/** Frameless-window controls the renderer's custom title bar drives. */
export interface WindowControls {
  minimize: () => void
  /** Toggle maximize ⇄ restore. */
  toggleMaximize: () => void
  close: () => void
  /** Current maximized state (for the maximize/restore glyph). */
  isMaximized: () => Promise<boolean>
  /** Subscribe to OS maximize/restore; returns an unsubscribe fn. */
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void
  /**
   * Tear a pane into a new window IF released outside this window. Main checks the
   * real cursor position, so this is robust to flaky drag coordinates. Resolves
   * `{ detached: true }` when a new window was spawned (caller should drop the pane).
   */
  tearOffPane: (descriptor: PaneDescriptor) => Promise<{ detached: boolean }>
  /** This window's pane descriptor when it is a detached-pane window, else null. */
  getDetachedPane: () => Promise<PaneDescriptor | null>
}

/** Options for spawning a pseudo-terminal in main. */
export interface PtySpawnOptions {
  /** Working directory (`~` is expanded; falls back to home if it doesn't exist). */
  cwd?: string
  cols: number
  rows: number
  /** Shell to launch; defaults to $SHELL (or a platform default). */
  shell?: string
  /** Attach as a read/write owner (default) or a read-only observer (e.g. the phone). */
  role?: 'owner' | 'observer'
  /** Resume replay from this stream cursor (reconnect); default 0 = full history. */
  sinceCursor?: number
}

/** Result of attaching to a pty: whether it was freshly spawned + buffered output to replay. */
export interface PtyAttachResult {
  created: boolean
  /** Output produced since `sinceCursor` (capped), to replay into the terminal. */
  buffer: string
  /** Stream position after `buffer` — pass back as `sinceCursor` to resume. */
  cursor: number
  /** True if `sinceCursor` predated retained history (buffer is a fresh full replay). */
  dropped: boolean
}

/**
 * Pseudo-terminal control surface, keyed by **pane id** so a pty survives the pane
 * remounting (split/relocate). The real pty lives in main (node-pty); output is buffered
 * there so a remounted terminal replays its history. `attach` returns `{ created:false }`
 * if a pty already existed for the pane. node-pty unavailable → `created:false, buffer:''`.
 * Working-directory tracking is NOT part of this surface: it rides inside `onData`'s stream
 * as OSC 7, emitted by shell-integration hooks main injects at spawn time, and is parsed
 * client-side by Terminal.tsx (`term.parser.registerOscHandler(7, …)`).
 */
export interface PtyApi {
  /** Attach to (or spawn) the pty for `paneId`; replay `buffer` into the new terminal. */
  attach: (paneId: string, opts: PtySpawnOptions) => Promise<PtyAttachResult>
  /** Stop receiving output (terminal unmounted) but keep the pty alive briefly to re-attach. */
  detach: (paneId: string) => void
  write: (paneId: string, data: string) => void
  resize: (paneId: string, cols: number, rows: number) => void
  /** Kill the pty immediately (e.g. the pane was closed). */
  kill: (paneId: string) => void
  /** Subscribe to output for the pane's pty; returns an unsubscribe fn. */
  onData: (paneId: string, cb: (data: string) => void) => () => void
  /** Subscribe to exit for the pane's pty; returns an unsubscribe fn. */
  onExit: (paneId: string, cb: (exitCode: number) => void) => () => void
}

/** One filesystem entry in a directory listing. */
export interface FsEntry {
  name: string
  dir: boolean
}

/** Filesystem access for the explorer + editor (privileged work stays in main). */
export interface FsApi {
  /** List a directory (dirs first, then files, alphabetical). `~` is expanded. Errors → []. */
  list: (path: string) => Promise<FsEntry[]>
  /** Read a file as UTF-8. Returns null on error (missing, binary-ish, permissions). */
  read: (path: string) => Promise<string | null>
  /** Write a file as UTF-8. Returns whether it succeeded. */
  write: (path: string, content: string) => Promise<boolean>
}

/** Result of starting a language server: an id to route messages + the resolved project root. */
export interface LspStartResult {
  id: string
  root: string
}

/** A configured language server and whether its binary is installed (on PATH). */
export interface LspServerInfo {
  languageId: string
  command: string
  installed: boolean
}

/**
 * Language-server bridge. Main spawns the server and frames JSON-RPC on its stdio; the
 * renderer owns the LSP `MessageConnection` over this transport. Messages are opaque
 * JSON-RPC objects (kept `unknown` so this file stays dependency-free).
 */
export interface LspApi {
  /** The configured language servers and whether each is installed (for the Plugins view). */
  list: () => Promise<LspServerInfo[]>
  /** Start (or reuse) a server for `languageId` rooted at `filePath`'s project. Null if none. */
  start: (languageId: string, filePath: string) => Promise<LspStartResult | null>
  send: (id: string, message: unknown) => void
  stop: (id: string) => void
  /** Subscribe to messages from server `id`; returns an unsubscribe fn. */
  onMessage: (id: string, cb: (message: unknown) => void) => () => void
  /** Subscribe to server `id` exiting; returns an unsubscribe fn. */
  onExit: (id: string, cb: () => void) => () => void
}

/** Settings-file access (the user-editable settings.json in userData). */
export interface SettingsApi {
  /** Absolute path of the settings.json file (also used to open it in the editor). */
  path: () => Promise<string>
}

/**
 * UI lifecycle transitions the renderer reports to main so it can maintain the pane
 * id/token registry (`main/idRegistry.ts`). Additive side-effect only — the renderer's
 * own state is never derived from these.
 */
export type LifecycleEvent =
  | { type: 'pane-created'; sessionId: string; paneId: string }
  | { type: 'pane-closed'; sessionId: string; paneId: string }
  | { type: 'session-added'; sessionId: string; workDir: string }
  | { type: 'session-closed'; sessionId: string }
  | { type: 'session-activated'; sessionId: string }

export interface LifecycleApi {
  /** Notify main of a UI lifecycle change so it can maintain the pane id/token registry. */
  emit: (event: LifecycleEvent) => void
}

/**
 * Command bridge wire types (Slice 6, spec §5.11 / §6). The renderer's command
 * registry (`src/renderer/commands/registry.ts`) is the source of truth for these
 * shapes; they live here (not there) so main/preload can reference them without
 * reaching into renderer code.
 */

/** Minimal JSON-Schema stand-in (no validator dep yet; shape is opaque here). */
export type JSONSchema = Record<string, unknown>

/** How a command resolves the pane it acts on. */
export type TargetMode = 'active' | 'explicit' | 'none'

export type CommandErrorCode = 'unknown-command' | 'command-failed' | 'needs-elevation'

export interface CommandError {
  code: CommandErrorCode
  message: string
}

/** Uniform result of executing a command (what the socket/CLI return). Discriminated on `ok`. */
export type CommandResult<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: CommandError }

/** Serialized, stable view of a command for external discovery. */
export interface CommandDescriptor {
  id: string
  title: string
  category: string | null
  hidden: boolean
  argsSchema: JSONSchema | null
  resultSchema: JSONSchema | null
  capabilities: Capability[]
  target: TargetMode
}

/** Explicit pane a non-UI caller (CLI / bridge) wants a command to act on. */
export interface CommandTarget {
  windowId?: string
  sessionId: string
  paneId: string | null
}

/** What main sends the renderer to invoke a command against an explicit target. */
export interface CommandInvokeRequest {
  id: string
  args?: unknown
  target: CommandTarget
}

export interface CommandsApi {
  /** Renderer → main: publish this window's command descriptors (for `pine commands`). */
  publish: (descriptors: CommandDescriptor[]) => void
  /** Register the handler main calls to execute a command here; returns an unsubscribe fn. */
  onInvoke: (handler: (req: CommandInvokeRequest) => Promise<CommandResult>) => () => void
}

/**
 * Slice 7: a compact, debounced snapshot of one pane's terminal state, pushed
 * renderer → main so main (and the control socket / `pine` CLI) can answer
 * "what is pane X doing" without reaching into renderer state. Main keeps a
 * per-pane read-model and REPLACES on newer-or-equal `generation` — see
 * `src/renderer/commands/terminalStateBridge.ts` (producer) and
 * `getTerminalState` in `src/main/index.ts` (read-model).
 */
export interface TerminalStateSnapshot {
  paneId: string
  /** Bumps on remount/reset so main can drop stale (pre-reset) snapshots. */
  generation: number
  cwd?: string
  /** Is a command currently executing (OSC 133 C seen, no matching D yet)? */
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export interface TerminalStateApi {
  /** Renderer → main: push this pane's latest terminal-state snapshot. */
  push: (snapshot: TerminalStateSnapshot) => void
}

/**
 * Browser-pane registration (Stage 2 agent automation, `src/main/browse.ts`). Main can only
 * drive a `browser` pane's `<webview>` guest through its `WebContents`, which only the
 * renderer can hand over (a webContents id is meaningless until the guest exists) — so the
 * renderer registers it on `dom-ready` and unregisters it on unmount.
 */
export interface BrowserApi {
  /** Register `paneId`'s live guest webContents id so `browse.*` control methods can find it. */
  register: (paneId: string, webContentsId: number) => void
  /** Drop the registration (pane unmounted/closed). */
  unregister: (paneId: string) => void
}

/** The typed API surface the preload bridge exposes on `window.pine`. */
export interface PineBridge {
  /** Liveness check round-trip to main. */
  ping: () => Promise<'pong'>
  /** Static app info resolved in main. */
  info: () => Promise<AppInfo>
  /** OS platform, available synchronously so the UI can pick its chrome at first paint. */
  platform: Platform
  /** Custom title-bar window controls. */
  window: WindowControls
  /** Pseudo-terminal streaming (node-pty in main ⇄ xterm.js in the renderer). */
  pty: PtyApi
  /** Read-only filesystem access for the explorer. */
  fs: FsApi
  /** Language-server bridge for the editor. */
  lsp: LspApi
  /** Settings-file access. */
  settings: SettingsApi
  /** UI lifecycle event reporting, backing the main-side pane id/token registry. */
  lifecycle: LifecycleApi
  /** Command bridge: publish this window's commands + accept invocations from main. */
  commands: CommandsApi
  /** Push per-pane terminal-state snapshots to main's read-model (Slice 7). */
  terminalState: TerminalStateApi
  /** Browser-pane registration for agent automation (Stage 2 `browse.*` control methods). */
  browser: BrowserApi
}

declare global {
  interface Window {
    pine: PineBridge
  }
}
