import { isNativeClipboardKey } from '@shared/chordSpec'
import type { Ghostty, Terminal as GhosttyTerm } from 'ghostty-web'
import { useEffect, useRef, useState } from 'react'
import { commands } from '../commands/registry'
import { fmt, useDict } from '../i18n/useDict'
import { keptShellReattached } from '../lib/autoResume'
import { isBrowserChord, isTerminalCommandChord, matchChord } from '../lib/chords'
import {
  PROGRAM_PASTE_KEY,
  keyPastePlan,
  pasteEventReadsClipboard,
  smartClipboardAction,
} from '../lib/clipboardKeys'
import { currentScheme, terminalTheme, useScheme } from '../lib/colorScheme'
import { acceptsPathDrop, droppedPaths, pathsAsInput } from '../lib/dropPaths'
import { terminalKeyData } from '../lib/keyPresets'
import { forgetPaneActivity, markPaneActivity } from '../lib/paneActivity'
import { commitProgramTitle, commitShellTitle } from '../lib/paneTitle'
import { planHumanPaste } from '../lib/pasteGate'
import { spawnPromptOption } from '../lib/promptChips'
import { terminalTitle } from '../lib/terminalTitle'
import { createTitleCommitter } from '../lib/titleCommit'
import { terminalFontStack } from '../lib/uiFonts'
import { isMac } from '../platform'
import { useAttentionStore } from '../stores/attentionStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { RiskyPasteDialog } from './RiskyPasteDialog'
import { nextSizeAction } from './terminalSizing'

type GhosttyModule = typeof import('ghostty-web')

let loading: Promise<{ lib: GhosttyModule; ghostty: Ghostty }> | null = null

function loadGhostty(): Promise<{ lib: GhosttyModule; ghostty: Ghostty }> {
  loading ??= import('ghostty-web').then(async (lib) => ({
    lib,
    ghostty: await lib.Ghostty.load(),
  }))
  loading.catch(() => {
    loading = null
  })
  return loading
}

const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O'])

const QUOTED_INSERT = '\x16'

function isShellQuotedInsert(e: KeyboardEvent, mac: boolean): boolean {
  return !mac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV'
}

export type GhosttyKeyAction =
  | { kind: 'pass' }
  | { kind: 'swallow' }
  | { kind: 'send'; data: string }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'command'; id: string }

export function ghosttyKeyAction(
  e: KeyboardEvent,
  hasSelection: boolean,
  clipboardKeys: Parameters<typeof smartClipboardAction>[1],
  mac: boolean,
): GhosttyKeyAction {
  const smart = smartClipboardAction(e, clipboardKeys, hasSelection, mac)
  if (smart) return { kind: smart }
  const chord = matchChord(e, mac)
  if (!chord || isBrowserChord(chord)) {
    const sent = terminalKeyData(e, mac)
    if (sent) return { kind: 'send', data: sent }
    return isShellQuotedInsert(e, mac) ? { kind: 'send', data: QUOTED_INSERT } : { kind: 'pass' }
  }
  if (chord === 'copy' || chord === 'paste') {
    if (mac && isNativeClipboardKey(e)) return { kind: 'pass' }
    return { kind: chord }
  }
  if (isTerminalCommandChord(chord)) return { kind: 'command', id: chord }
  return { kind: 'swallow' }
}

export function GhosttyTerminalView({
  workspaceId,
  paneId,
  cwd,
}: {
  workspaceId: string
  paneId: string
  cwd?: string
}): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<GhosttyTerm | null>(null)
  const pasteRef = useRef<(text: string) => void>(() => {})
  const spawnCwd = useRef(cwd)
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const [failure, setFailure] = useState<string | null>(null)
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)
  const font = useSettingsStore((s) => s.appearance.terminal)
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const palette = useScheme('terminal').colors

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let teardown = (): void => {}
    loadGhostty()
      .then(({ lib, ghostty }) => {
        if (disposed) return
        teardown = mountGhostty(lib, ghostty, host)
      })
      .catch((err: unknown) => {
        if (!disposed) setFailure(err instanceof Error ? err.message : String(err))
      })

    function mountGhostty(lib: GhosttyModule, ghostty: Ghostty, host: HTMLDivElement): () => void {
      const settings = useSettingsStore.getState()
      const term = new lib.Terminal({
        ghostty,
        theme: terminalTheme(currentScheme('terminal').colors),
        fontFamily: terminalFontStack(settings.appearance.terminal.family),
        fontSize: settings.appearance.terminal.size,
        cursorStyle: settings.behavior.cursorStyle,
        cursorBlink: settings.behavior.cursorBlink,
        scrollback: settings.terminal.scrollbackLines,
      })
      const fit = new lib.FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term

      let replaying = false
      let attached = false
      let replayed = false
      const pending: string[] = []
      let last = { cols: 0, rows: 0 }

      const pasteConfirmed = (text: string): void => term.paste(text)
      pasteRef.current = pasteConfirmed
      const requestPaste = (text: string): void => {
        const plan = planHumanPaste(text, useSettingsStore.getState().terminal.warnOnRiskyPaste)
        if (plan.confirm) setPendingPaste(plan.text)
        else if (plan.text) pasteConfirmed(plan.text)
      }
      const pasteFromClipboard = async (): Promise<void> => {
        const text = await navigator.clipboard.readText().catch(() => '')
        if (disposed) return
        const hasImage = !text && (await window.ostia.clipboard.hasImage().catch(() => false))
        if (disposed) return
        const plan = keyPastePlan(text, false, hasImage)
        if (plan === 'text') requestPaste(text)
        else if (plan === 'program') term.input(PROGRAM_PASTE_KEY, true)
      }
      const interceptPaste = (e: ClipboardEvent): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
        const text = e.clipboardData?.getData('text/plain') ?? ''
        if (pasteEventReadsClipboard(text, false, isMac)) void pasteFromClipboard()
        else requestPaste(text)
      }
      host.addEventListener('paste', interceptPaste, true)

      term.attachCustomKeyEventHandler((e) => {
        const action = ghosttyKeyAction(
          e,
          term.hasSelection(),
          useSettingsStore.getState().terminal.clipboardKeys,
          isMac,
        )
        if (action.kind === 'pass') return false
        if (action.kind === 'send') term.input(action.data, true)
        else if (action.kind === 'copy') {
          const selection = term.getSelection()
          if (selection) void navigator.clipboard.writeText(selection)
        } else if (action.kind === 'paste') void pasteFromClipboard()
        else if (action.kind === 'command') void commands.exec(action.id)
        return true
      })

      const titles = createTitleCommitter((title) =>
        commitProgramTitle(workspaceIdRef.current, paneId, title),
      )
      const titleChange = term.onTitleChange((raw) => {
        const title = terminalTitle(raw)
        if (title) titles.push(title)
      })
      const copySelection = term.onSelectionChange(() => {
        if (!useSettingsStore.getState().behavior.copyOnSelect || !term.hasSelection()) return
        void navigator.clipboard.writeText(term.getSelection())
      })

      markPaneActivity(paneId)
      const offData = window.ostia.pty.onData(paneId, (data) => {
        markPaneActivity(paneId)
        if (replayed) term.write(data)
        else pending.push(data)
      })
      const offExit = window.ostia.pty.onExit(paneId, (_code, closes) => {
        term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
        if (closes || useSandboxStore.getState().hostPanes[paneId]) {
          useLayoutStore.getState().closePane(workspaceIdRef.current, paneId)
        }
      })
      const flushPending = (): void => {
        replayed = true
        for (const data of pending) term.write(data)
        pending.length = 0
      }
      const attach = (cols: number, rows: number): void => {
        attached = true
        last = { cols, rows }
        window.ostia.pty
          .attach(paneId, {
            cwd: spawnCwd.current,
            cols,
            rows,
            role: 'owner',
            workspaceId: workspaceIdRef.current,
            hostToken: useSandboxStore.getState().takeHostToken(paneId),
            ...spawnPromptOption(useSettingsStore.getState()),
          })
          .then(({ buffer, sandboxed, sandboxStamp, host: isHost, shell, reattached }) => {
            if (disposed) return
            if (reattached) keptShellReattached(workspaceIdRef.current, paneId)
            commitShellTitle(workspaceIdRef.current, paneId, shell)
            useSandboxStore.getState().notePane(paneId, sandboxed ?? false, sandboxStamp)
            if (isHost) useSandboxStore.getState().noteHost(paneId)
            if (buffer) {
              replaying = true
              term.write(buffer, () => {
                replaying = false
              })
            }
            flushPending()
          })
          .catch((err: unknown) => {
            if (disposed) return
            const reason = err instanceof Error ? err.message : String(err)
            term.writeln(`\x1b[2m[failed to start shell: ${reason}]\x1b[0m`)
            flushPending()
          })
      }
      const syncSize = (): void => {
        const fitted = host.offsetWidth > 0 && host.offsetHeight > 0
        if (fitted) fit.fit()
        const action = nextSizeAction({ fitted, attached, cols: term.cols, rows: term.rows, last })
        if (action.type === 'attach') attach(action.cols, action.rows)
        else if (action.type === 'resize') {
          last = { cols: action.cols, rows: action.rows }
          window.ostia.pty.resize(paneId, action.cols, action.rows)
        }
      }

      const input = term.onData((data) => {
        if (replaying) return
        window.ostia.pty.write(paneId, data)
        if (FOCUS_REPORTS.has(data)) return
        markPaneActivity(paneId)
        if (useAttentionStore.getState().byPane[paneId]?.state === 'waiting') {
          useAttentionStore.getState().dispatch(paneId, { type: 'input', at: Date.now() })
        }
      })

      syncSize()
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
        if (resizeTimer) clearTimeout(resizeTimer)
        if (rafId) cancelAnimationFrame(rafId)
        ro.disconnect()
        input.dispose()
        titleChange.dispose()
        titles.cancel()
        copySelection.dispose()
        host.removeEventListener('paste', interceptPaste, true)
        pasteRef.current = () => {}
        offData()
        offExit()
        forgetPaneActivity(paneId)
        window.ostia.pty.detach(paneId)
        term.dispose()
        termRef.current = null
      }
    }

    return () => {
      disposed = true
      teardown()
      setFailure(null)
      setPendingPaste(null)
    }
  }, [paneId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack(font.family)
    term.options.fontSize = font.size
  }, [font.family, font.size])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
  }, [cursorStyle, cursorBlink])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(palette)
  }, [palette])

  const closePasteDialog = (): void => {
    setPendingPaste(null)
    termRef.current?.focus()
  }

  return (
    <div
      className="terminal-surface"
      onDragOver={(e) => {
        if (!acceptsPathDrop([...e.dataTransfer.types])) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        if (!acceptsPathDrop([...e.dataTransfer.types])) return
        e.preventDefault()
        const text = pathsAsInput(droppedPaths(e.dataTransfer))
        if (!text) return
        pasteRef.current(text)
        termRef.current?.focus()
      }}
    >
      <div className="terminal-stack">
        <div
          ref={hostRef}
          className="ghostty-host"
          data-terminal-renderer="ghostty"
          style={{ background: palette.background }}
        />
        {failure ? (
          <p role="alert" className="ghostty-failure text-fg-muted text-ui-sm">
            {fmt(d.settings.ghosttyFailed, { reason: failure })}
          </p>
        ) : null}
      </div>
      <RiskyPasteDialog
        text={pendingPaste}
        source="human"
        onPaste={(text) => {
          pasteRef.current(text)
          closePasteDialog()
        }}
        onCancel={closePasteDialog}
      />
    </div>
  )
}
