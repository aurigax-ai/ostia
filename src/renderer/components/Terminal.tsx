import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Blocks } from './Blocks'
import { nextSizeAction } from './terminalSizing'
import { terminalPalette } from './terminalTheme'

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
  const themeId = useSettingsStore((s) => s.appearance.theme)

  // Create the xterm, then attach to the pane's pty (keyed by pane id). The pty + its output
  // buffer live in main, so on a remount (split/relocate) we re-attach and replay history
  // instead of restarting the shell. Font is read from the store so font changes don't restart.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.terminal
    const behavior = useSettingsStore.getState().behavior
    const term = new Xterm({
      theme: terminalPalette(useSettingsStore.getState().appearance.theme),
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

    let disposed = false
    let attached = false
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

    // Spawn the pty at the REAL fitted size — NEVER xterm's 80×24 default. If we attached at the
    // default and then grew to the real box, the shell's first prompt (and its right-aligned
    // RPROMPT) would be drawn at the wrong width and stranded by xterm's reflow — the "staircase"
    // of prompts. So attach is deferred until the host has a real layout box and FitAddon yields
    // a valid size (the ResizeObserver drives the first fit when the portal slot lays out).
    const attachAtCurrentSize = (cols: number, rows: number): void => {
      attached = true
      lastSizeRef.current = { cols, rows }
      window.pine.pty
        .attach(paneId, { cwd: spawnCwd.current, cols, rows, role: 'owner' })
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
    }

    // cmux fit rule: never fit a 0-sized host (0 cols/rows corrupts the pty buffer) and never
    // forward a 0×0 or unchanged size to the pty. The FIRST valid fit spawns the pty at that
    // size; later valid fits just resize the existing pty.
    const applyFit = (): void => {
      const fitted = safeFit(host, fit)
      const { cols, rows } = term
      const action = nextSizeAction({ fitted, attached, cols, rows, last: lastSizeRef.current })
      if (action.type === 'attach') {
        attachAtCurrentSize(action.cols, action.rows)
      } else if (action.type === 'resize') {
        lastSizeRef.current = { cols: action.cols, rows: action.rows }
        window.pine.pty.resize(paneId, action.cols, action.rows)
      }
    }

    // The prompt line effectively spans the full width (right-aligned RPROMPT at the last
    // column), so on a narrowing resize xterm's reflow wraps the OLD prompt line into extra
    // rows — and the shell's SIGWINCH redraw only clears from the row it believes the prompt
    // starts on, stranding the wrapped rows above (the "prompt duplicates on split" bug,
    // e2e/resize-prompt.spec.ts). kitty and Warp solve this the same way: when the pane is
    // sitting at a shell prompt, ERASE the prompt region before applying the resize and let
    // the shell's redraw repaint one fresh prompt. We anchor the erase at the open OSC 133;A
    // mark (blocksStore draft); with a command running — or no integration (fish/sh) — we
    // skip and degrade to plain reflow, which is normal terminal behavior for output.
    const syncSize = (): void => {
      if (attached && host && fit && host.offsetWidth > 0 && host.offsetHeight > 0) {
        // Peek at the would-be grid without applying it, so the erase happens BEFORE reflow.
        const dims = fit.proposeDimensions()
        const last = lastSizeRef.current
        if (
          dims &&
          dims.cols > 0 &&
          dims.rows > 0 &&
          (dims.cols !== last.cols || dims.rows !== last.rows)
        ) {
          const blocks = useBlocksStore.getState()
          const draft = blocks.drafts[paneId]
          if (draft && !blocks.running[paneId]) {
            const row = draft.promptLine - term.buffer.active.baseY + 1
            if (row >= 1 && row <= term.rows) {
              // Park the cursor at the prompt's first row and clear to the end of the screen;
              // resize only after xterm has PARSED the erase (write is queued — resizing first
              // would reflow the still-dirty buffer and strand rows anyway). CRITICAL: erase and
              // resize are atomic — apply the CAPTURED dims directly rather than re-running
              // fit-and-dedup in the callback. A re-check could conclude "unchanged, skip" (the
              // layout bounced back between propose and parse), which would leave the screen
              // erased with no SIGWINCH to make the shell repaint — a vanished prompt.
              term.write(`\x1b[${row};1H\x1b[0J`, () => {
                if (disposed) return
                term.resize(dims.cols, dims.rows)
                lastSizeRef.current = { cols: dims.cols, rows: dims.rows }
                window.pine.pty.resize(paneId, dims.cols, dims.rows)
              })
              return
            }
          }
        }
      }
      applyFit()
    }

    const input = term.onData((d) => window.pine.pty.write(paneId, d))

    // Common case: the slot already has a box on first paint → fit + attach immediately. If it's
    // still 0×0, syncSize() no-ops and the ResizeObserver attaches the moment the box appears.
    syncSize()

    // Debounce resize. A drag fires dozens of RO callbacks/sec; fitting + SIGWINCH on each makes
    // the shell redraw its prompt (and RPROMPT clock) every frame — the stacking "staircase" of
    // prompts. Coalesce to the final size after a short idle so the shell redraws once (same
    // technique as VSCode / cmux-wmux). The FIRST attach, though, must happen ASAP once we have a
    // real box, so while unattached the RO drives syncSize immediately (no debounce).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let rafId = 0
    const ro = new ResizeObserver(() => {
      if (!attached) {
        syncSize()
        return
      }
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
    // Only resize if the fit actually ran (host has a box) — never send a default-size resize to
    // a pty that may not be attached yet (see the mount effect's deferred-attach rationale).
    if (!safeFit(hostRef.current, fitRef.current)) return
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

  // Apply app-theme changes to the xterm ANSI palette live, without restarting the shell —
  // same "read from the store, patch term.options" pattern as font/cursor above.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalPalette(themeId)
  }, [themeId])

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
function safeFit(host: HTMLElement | null, fit: FitAddon | null): boolean {
  if (!fit || !host || host.offsetWidth === 0 || host.offsetHeight === 0) return false
  try {
    fit.fit()
    return true
  } catch {
    // not laid out yet
    return false
  }
}
