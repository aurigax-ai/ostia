import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Blocks } from './Blocks'

/** One Dark Vivid ANSI palette (matches the app theme; xterm renders to canvas, so hex). */
const THEME = {
  background: '#282c34',
  foreground: '#d7dae0',
  cursor: '#61afef',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(97, 175, 239, 0.25)',
  black: '#3a4150',
  red: '#ef596f',
  green: '#89ca78',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#d55fde',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#636d83',
  brightRed: '#ef596f',
  brightGreen: '#89ca78',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#d55fde',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
}

/** Bundled Hack Nerd Font Mono leads; fallbacks keep glyphs monospaced. */
const MONO_FALLBACK = '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const fontStack = (family: string): string => `"${family}", ${MONO_FALLBACK}`

/**
 * A live terminal surface: xterm.js wired to a node-pty session in main over the
 * `window.pine.pty` bridge. One pty per mounted terminal; killed on unmount. The font
 * comes from Settings → Terminal (default Hack Nerd Font Mono, for Nerd Font glyphs).
 */
export function TerminalView({
  sessionId,
  paneId,
  cwd,
}: {
  sessionId: string
  paneId: string
  cwd?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  // Spawn dir is captured once at mount; later cwd updates flow OUT (terminal → pane), not in.
  const spawnCwd = useRef(cwd)
  const font = useSettingsStore((s) => s.appearance.terminal)
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)

  // Create the xterm, then attach to the pane's pty (keyed by pane id). The pty + its output
  // buffer live in main, so on a remount (split/relocate) we re-attach and replay history
  // instead of restarting the shell. Font is read from the store so font changes don't restart.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.terminal
    const behavior = useSettingsStore.getState().behavior
    const term = new Xterm({
      theme: THEME,
      fontFamily: fontStack(initial.family),
      fontSize: initial.size,
      lineHeight: 1.15,
      cursorStyle: behavior.cursorStyle,
      cursorBlink: behavior.cursorBlink,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    // Shell-integration marks (see src/main/shellIntegration.ts), registered before any
    // buffer replay below so a remount re-parses OSC 7/133 from the replayed history too.
    const cwdRef = { current: spawnCwd.current ?? null }
    const oscCwd = term.parser.registerOscHandler(7, (data) => {
      const path = decodeOsc7(data)
      if (path) {
        cwdRef.current = path
        useLayoutStore.getState().setCwd(sessionId, paneId, path)
      }
      return true
    })
    const oscBlocks = term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';')
      const line = term.buffer.active.baseY + term.buffer.active.cursorY
      const blocks = useBlocksStore.getState()
      if (kind === 'A') blocks.promptStart(paneId, line, cwdRef.current)
      else if (kind === 'B') blocks.promptEnd(paneId, line)
      else if (kind === 'C') blocks.commandStart(paneId, line)
      else if (kind === 'D') blocks.commandEnd(paneId, line, Number(arg ?? 0))
      return true
    })

    // cmux fit rule: never fit a 0-sized host (0 cols/rows corrupts the pty buffer) and
    // never forward a 0×0 or unchanged size to the pty.
    const syncSize = (): void => {
      safeFit(host, fit)
      const { cols, rows } = term
      const last = lastSizeRef.current
      if (cols > 0 && rows > 0 && (cols !== last.cols || rows !== last.rows)) {
        lastSizeRef.current = { cols, rows }
        window.pine.pty.resize(paneId, cols, rows)
      }
    }
    syncSize()

    let disposed = false
    // Subscribe to live pty output BEFORE attaching, so bytes emitted between (re)attach and
    // now aren't dropped (Codex). Queue them until the replay buffer is written, then flush.
    let replayed = false
    const pending: string[] = []
    const offData = window.pine.pty.onData(paneId, (d) => {
      if (replayed) term.write(d)
      else pending.push(d)
    })
    const offExit = window.pine.pty.onExit(paneId, () =>
      term.writeln('\r\n\x1b[2m[process exited]\x1b[0m'),
    )

    window.pine.pty
      .attach(paneId, { cwd: spawnCwd.current, cols: term.cols, rows: term.rows })
      .then(({ buffer }) => {
        if (disposed) return
        // A remount replays history, which re-parses OSC 133 marks — clear this pane's blocks
        // first so they rebuild cleanly instead of appending duplicates (Codex).
        useBlocksStore.getState().resetPane(paneId)
        if (buffer) term.write(buffer) // replay history into the fresh terminal
        replayed = true
        for (const d of pending) term.write(d)
        pending.length = 0
      })

    const input = term.onData((d) => window.pine.pty.write(paneId, d))

    // Debounce resize. A drag fires dozens of RO callbacks/sec; fitting + SIGWINCH on each
    // makes the shell redraw its prompt (and RPROMPT clock) every frame — the stacking
    // "staircase" of prompts. Coalesce to the final size after a short idle so the shell
    // redraws once. (Same technique as VSCode / cmux-wmux.)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let rafId = 0
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        rafId = requestAnimationFrame(syncSize)
      }, 90)
    })
    ro.observe(host)

    return () => {
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (rafId) cancelAnimationFrame(rafId) // else a queued fit runs on a disposed term
      ro.disconnect()
      input.dispose()
      offData()
      offExit()
      oscCwd.dispose()
      oscBlocks.dispose()
      window.pine.pty.detach(paneId) // keep the pty alive briefly for a remount
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, paneId])

  // Apply terminal-font changes live, without restarting the shell.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontStack(font.family)
    term.options.fontSize = font.size
    safeFit(hostRef.current, fitRef.current)
    const { cols, rows } = term
    const last = lastSizeRef.current
    if (cols > 0 && rows > 0 && (cols !== last.cols || rows !== last.rows)) {
      lastSizeRef.current = { cols, rows }
      window.pine.pty.resize(paneId, cols, rows)
    }
  }, [font.family, font.size, paneId])

  // Apply cursor style/blink changes live.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
  }, [cursorStyle, cursorBlink])

  return (
    <>
      <div ref={hostRef} className="xterm-host" />
      <Blocks paneId={paneId} termRef={termRef} hostRef={hostRef} />
    </>
  )
}

/**
 * Extract the path from an OSC 7 `file://<host><path>` payload. Our shell hooks emit the
 * RAW (un-percent-encoded) path, so we do NOT decodeURIComponent — that would corrupt a
 * real directory containing a `%xx`-looking segment (e.g. `.../100%20off`).
 */
function decodeOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data)
  return m ? m[1] : null
}

/**
 * Fit xterm to its host — but NEVER when the host is 0-sized: FitAddon would compute
 * 0 cols/rows and corrupt the pty buffer (the cmux "infinite duplication" bug). The
 * ResizeObserver retries once the host has a real box.
 */
function safeFit(host: HTMLElement | null, fit: FitAddon | null): void {
  if (!fit || !host || host.offsetWidth === 0 || host.offsetHeight === 0) return
  try {
    fit.fit()
  } catch {
    // not laid out yet
  }
}
