import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type FontWeight, type IMarker, Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { wantsDesktopBanner } from '../../shared/notificationSettings'
import { currentDict, fmt } from '../i18n/useDict'
import {
  KittyNotificationAssembler,
  type OscNotification,
  notificationMessage,
  parseOsc9,
  parseOsc99,
  parseOsc777,
} from '../lib/attention'
import { canTypeInto, insertCommand, stepBlock } from '../lib/blockActions'
import { decodeCommandLine, readCommandText } from '../lib/blockText'
import { isIdlePrompt } from '../lib/blocks'
import { isAppChord, isNativeClipboardKey, matchChord } from '../lib/chords'
import { openFileAt } from '../lib/openFile'
import { forgetPaneActivity, markPaneActivity } from '../lib/paneActivity'
import { createFileLinkProvider } from '../lib/terminalFileLinks'
import { registerTerminal } from '../lib/terminalHandles'
import { terminalTitle } from '../lib/terminalTitle'
import { DEFAULT_DARK_THEME, currentTheme, useEffectiveTheme } from '../lib/theme'
import { loadWebglRenderer } from '../lib/webglRenderer'
import { attachWheelZoom } from '../lib/wheelZoom'
import {
  isPaneViewed,
  isPaneVisible,
  shouldNotifyCommandEnd,
  signalPane,
} from '../lib/workspaceActivity'
import { isMac } from '../platform'
import { isRiskyPaste } from '../settings/terminalPaneSettings'
import { useAttentionStore } from '../stores/attentionStore'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Blocks } from './Blocks'
import { InputEditor } from './InputEditor'
import { RiskyPasteDialog } from './RiskyPasteDialog'
import { TerminalFind, findOptions } from './TerminalFind'
import { isPromptRepaint, nextSizeAction } from './terminalSizing'
import { terminalPalette } from './terminalTheme'

const MONO_FALLBACK = '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const fontStack = (family: string): string => `"${family}", ${MONO_FALLBACK}`
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O'])

export function TerminalView({
  workspaceId,
  paneId,
  cwd,
}: {
  workspaceId: string
  paneId: string
  cwd?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const spawnCwd = useRef(cwd)
  const font = useSettingsStore((s) => s.appearance.terminal)
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const themeId = useEffectiveTheme()?.id ?? DEFAULT_DARK_THEME
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const pasteRef = useRef<(text: string) => void>(() => {})
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchAddon | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [alternateScreen, setAlternateScreen] = useState(false)
  const [suppressedPrompt, setSuppressedPrompt] = useState<LineAnchor | null>(null)
  const searchOptions = useMemo(() => findOptions(terminalPalette(themeId)), [themeId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.terminal
    const behavior = useSettingsStore.getState().behavior
    const terminalSettings = useSettingsStore.getState().terminal
    const term = new Xterm({
      theme: terminalPalette(currentTheme()?.id ?? DEFAULT_DARK_THEME),
      fontFamily: fontStack(initial.family),
      fontSize: initial.size,
      fontWeight: initial.weight as FontWeight,
      lineHeight: initial.lineHeight,
      cursorStyle: behavior.cursorStyle,
      cursorBlink: behavior.cursorBlink,
      scrollback: terminalSettings.scrollbackLines,
      scrollSensitivity: terminalSettings.scrollSpeed,
      minimumContrastRatio: terminalSettings.minimumContrast,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (!(isMac ? e.metaKey : e.ctrlKey)) return
        if (useSettingsStore.getState().browser.openTerminalLinks) {
          useLayoutStore.getState().openBrowser(workspaceId, uri)
        } else {
          window.open(uri, '_blank')
        }
      }),
    )
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.open(host)
    if (behavior.gpuAcceleration) loadWebglRenderer(term)
    const detachWheelZoom = attachWheelZoom(host, 'terminal', isMac)
    termRef.current = term
    fitRef.current = fit
    setSearch(searchAddon)
    const unregisterTerminal = registerTerminal(paneId, term)
    const suppressInputEditor = (): void => {
      const blocks = useBlocksStore.getState()
      if (useSettingsStore.getState().behavior.inputMode !== 'editor') return
      if (!isIdlePrompt(blocks, paneId)) return
      setSuppressedPrompt(blocks.drafts[paneId]?.promptLine ?? null)
    }
    const shellKeys = term.onKey(suppressInputEditor)
    const pasteConfirmed = (text: string): void => {
      suppressInputEditor()
      term.paste(text)
    }
    pasteRef.current = pasteConfirmed
    const requestPaste = (text: string): void => {
      if (!text || disposed) return
      if (useSettingsStore.getState().terminal.warnOnRiskyPaste && isRiskyPaste(text)) {
        setPendingPaste(text)
        return
      }
      pasteConfirmed(text)
    }
    const interceptPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!useSettingsStore.getState().terminal.warnOnRiskyPaste || !isRiskyPaste(text)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      requestPaste(text)
    }
    host.addEventListener('paste', interceptPaste, true)
    host.addEventListener('paste', suppressInputEditor, true)
    const bufferChange = term.buffer.onBufferChange((buffer) =>
      setAlternateScreen(buffer.type === 'alternate'),
    )

    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const blocks = useBlocksStore.getState()
        if (!blocks.selected[paneId]) return true
        if (e.type === 'keydown') blocks.select(paneId, null)
        return false
      }
      const chord = matchChord(e, isMac)
      if (!chord) return true
      const clipboard = chord === 'copy' || chord === 'paste'
      if (isMac && clipboard && isNativeClipboardKey(e)) return true
      if (e.type !== 'keydown' || isAppChord(chord)) return false
      e.preventDefault()
      if (chord === 'find') setFindOpen(true)
      else if (chord === 'block.selectPrev') stepBlock(paneId, 'prev')
      else if (chord === 'block.selectNext') stepBlock(paneId, 'next')
      else if (chord === 'copy') {
        const selection = term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
      } else {
        void navigator.clipboard.readText().then(requestPaste)
      }
      return false
    })

    const cwdRef = { current: spawnCwd.current ?? null }
    let promptMarker: IMarker | undefined
    const markers = new Set<IMarker>()
    const anchor = (): LineAnchor => {
      const marker = term.registerMarker(0)
      if (!marker) return { line: term.buffer.active.baseY + term.buffer.active.cursorY }
      markers.add(marker)
      marker.onDispose(() => markers.delete(marker))
      return marker
    }
    const disposeMarkers = (): void => {
      for (const marker of [...markers]) marker.dispose()
    }
    let inputAnchor: LineAnchor | null = null
    let inputCol = 0
    let runningCommand = ''
    let replaying = false
    const onCommandEnd = (exitCode: number): void => {
      const blocks = useBlocksStore.getState()
      const runningId = blocks.running[paneId]
      const block = runningId ? blocks.byPane[paneId]?.find((b) => b.id === runningId) : undefined
      blocks.commandEnd(paneId, anchor(), exitCode, term.buffer.active.cursorX)
      if (!block || replaying) return
      const long = shouldNotifyCommandEnd(Date.now() - block.startedAt, document.hasFocus())
      if (isPaneViewed(paneId) || (exitCode === 0 && !long)) return
      const d = currentDict()
      const title =
        exitCode === 0
          ? d.attention.commandFinished
          : fmt(d.attention.commandFailed, { code: exitCode })
      const body = runningCommand || block.cwd || undefined
      useAttentionStore.getState().dispatch(paneId, {
        type: 'commandEnd',
        exitCode,
        long,
        message: body ? `${title}: ${body}` : title,
        at: Date.now(),
      })
      if (long) {
        window.pine.notifications.post({
          paneId,
          title,
          body,
          desktop: wantsDesktopBanner(
            useSettingsStore.getState().notifications,
            'commandFinished',
            false,
          ),
        })
      }
    }
    const notifyFromTerminal = (n: OscNotification | null): boolean => {
      if (!n || replaying) return true
      signalPane(paneId, {
        type: 'notify',
        message: notificationMessage(n),
        waiting: true,
        at: Date.now(),
      })
      window.pine.notifications.post({
        paneId,
        title: n.title,
        body: n.body,
        desktop: wantsDesktopBanner(
          useSettingsStore.getState().notifications,
          'message',
          document.hasFocus() && isPaneVisible(paneId),
        ),
      })
      return true
    }
    const kitty = new KittyNotificationAssembler()
    const oscNotify9 = term.parser.registerOscHandler(9, (data) =>
      notifyFromTerminal(parseOsc9(data)),
    )
    const oscNotify777 = term.parser.registerOscHandler(777, (data) =>
      notifyFromTerminal(parseOsc777(data)),
    )
    const oscNotify99 = term.parser.registerOscHandler(99, (data) => {
      const chunk = parseOsc99(data, decodeBase64Utf8)
      return notifyFromTerminal(chunk ? kitty.push(chunk) : null)
    })
    const fileLinks = term.registerLinkProvider(
      createFileLinkProvider(term, {
        cwd: () => cwdRef.current,
        stat: (path) => window.pine.fs.stat(path),
        open: openFileAt,
        modifierHeld: (e) => (isMac ? e.metaKey : e.ctrlKey),
      }),
    )
    const copySelection = term.onSelectionChange(() => {
      if (!useSettingsStore.getState().behavior.copyOnSelect || !term.hasSelection()) return
      void navigator.clipboard.writeText(term.getSelection())
    })
    const titleChange = term.onTitleChange((raw) => {
      const title = terminalTitle(raw)
      if (title) useLayoutStore.getState().setTitle(workspaceId, paneId, title)
    })
    const bell = term.onBell(() => {
      if (replaying || isPaneViewed(paneId)) return
      useAttentionStore.getState().dispatch(paneId, { type: 'bell', at: Date.now() })
    })
    const oscCwd = term.parser.registerOscHandler(7, (data) => {
      const path = decodeOsc7(data)
      if (path) {
        cwdRef.current = path
        useLayoutStore.getState().setCwd(workspaceId, paneId, path)
      }
      return true
    })
    let reportedCommand: string | null = null
    const oscCommandLine = term.parser.registerOscHandler(633, (data) => {
      if (data.startsWith('E;')) reportedCommand = decodeCommandLine(data.slice(2))
      return true
    })
    const oscBlocks = term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';')
      const blocks = useBlocksStore.getState()
      if (kind === 'A') {
        promptMarker?.dispose()
        promptMarker = term.registerMarker(0)
        inputAnchor = null
        reportedCommand = null
        blocks.promptStart(paneId, anchor(), cwdRef.current)
      } else if (kind === 'B') {
        inputAnchor = anchor()
        inputCol = term.buffer.active.cursorX
        blocks.promptEnd(paneId, inputAnchor)
      } else if (kind === 'C') {
        const start = anchor()
        runningCommand =
          reportedCommand ??
          (inputAnchor
            ? readCommandText(
                term.buffer.active,
                { line: inputAnchor.line, col: inputCol },
                { line: start.line, col: term.buffer.active.cursorX },
              )
            : '')
        reportedCommand = null
        blocks.commandStart(paneId, start, runningCommand)
        if (!replaying) {
          useAttentionStore.getState().dispatch(paneId, { type: 'commandStart', at: Date.now() })
        }
      } else if (kind === 'D') onCommandEnd(Number(arg ?? 0))
      return true
    })

    let disposed = false
    let attached = false
    let replayed = false
    const pending: string[] = []
    let holdForRedraw = false
    let held: string[] = []
    let holdIdleTimer: ReturnType<typeof setTimeout> | null = null
    let holdCapTimer: ReturnType<typeof setTimeout> | null = null
    let holdEraseRow = 1
    let holdCursor = { row: 1, col: 1 }
    let holdDims = { cols: 0, rows: 0 }
    markPaneActivity(paneId)
    const offData = window.pine.pty.onData(paneId, (d) => {
      markPaneActivity(paneId)
      if (!replayed) {
        pending.push(d)
      } else if (holdForRedraw) {
        held.push(d)
        if (holdIdleTimer) clearTimeout(holdIdleTimer)
        holdIdleTimer = setTimeout(flushHold, 24)
      } else {
        term.write(d)
      }
    })
    const offExit = window.pine.pty.onExit(paneId, () =>
      term.writeln('\r\n\x1b[2m[process exited]\x1b[0m'),
    )

    const attachAtCurrentSize = (cols: number, rows: number): void => {
      attached = true
      lastSizeRef.current = { cols, rows }
      const flushPending = (): void => {
        replayed = true
        for (const d of pending) term.write(d)
        pending.length = 0
      }
      window.pine.pty
        .attach(paneId, { cwd: spawnCwd.current, cols, rows, role: 'owner' })
        .then(({ buffer }) => {
          if (disposed) return
          disposeMarkers()
          useBlocksStore.getState().resetPane(paneId)
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

    const flushHold = (): void => {
      if (!holdForRedraw) return
      holdForRedraw = false
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      if (holdCapTimer) clearTimeout(holdCapTimer)
      holdIdleTimer = null
      holdCapTimer = null
      if (disposed) return
      const redraw = held.join('')
      held = []
      const { cols, rows } = holdDims
      if (redraw.length > 0 && isPromptRepaint(redraw)) {
        const restore = `\x1b[${holdCursor.row};${holdCursor.col}H`
        term.write(`\x1b[${holdEraseRow};1H\x1b[0J${restore}`, () => {
          if (disposed) return
          term.resize(cols, rows)
          term.write(redraw)
          syncSize()
        })
      } else {
        term.resize(cols, rows)
        if (redraw.length > 0) term.write(redraw)
        syncSize()
      }
    }
    const syncSize = (): void => {
      if (holdForRedraw) return
      if (attached && host && fit && host.offsetWidth > 0 && host.offsetHeight > 0) {
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
            const markLine = promptMarker && !promptMarker.isDisposed ? promptMarker.line : -1
            const draftRow = markLine - term.buffer.active.baseY + 1
            const cursorRow = term.buffer.active.cursorY + 1
            holdCursor = { row: cursorRow, col: term.buffer.active.cursorX + 1 }
            holdEraseRow =
              draftRow >= 1 && draftRow <= term.rows ? Math.min(draftRow, cursorRow) : cursorRow
            holdDims = { cols: dims.cols, rows: dims.rows }
            holdForRedraw = true
            lastSizeRef.current = { cols: dims.cols, rows: dims.rows }
            window.pine.pty.resize(paneId, dims.cols, dims.rows)
            holdCapTimer = setTimeout(flushHold, 150)
            return
          }
        }
      }
      applyFit()
    }

    const input = term.onData((d) => {
      window.pine.pty.write(paneId, d)
      if (!FOCUS_REPORTS.has(d)) markPaneActivity(paneId)
      if (!FOCUS_REPORTS.has(d) && useBlocksStore.getState().selected[paneId]) {
        useBlocksStore.getState().select(paneId, null)
      }
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
      disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (rafId) cancelAnimationFrame(rafId)
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      if (holdCapTimer) clearTimeout(holdCapTimer)
      ro.disconnect()
      input.dispose()
      shellKeys.dispose()
      bufferChange.dispose()
      host.removeEventListener('paste', interceptPaste, true)
      host.removeEventListener('paste', suppressInputEditor, true)
      pasteRef.current = () => {}
      offData()
      offExit()
      oscCwd.dispose()
      oscBlocks.dispose()
      oscCommandLine.dispose()
      oscNotify9.dispose()
      oscNotify777.dispose()
      oscNotify99.dispose()
      bell.dispose()
      copySelection.dispose()
      fileLinks.dispose()
      detachWheelZoom()
      titleChange.dispose()
      promptMarker?.dispose()
      disposeMarkers()
      unregisterTerminal()
      forgetPaneActivity(paneId)
      useBlocksStore.getState().dropPane(paneId)
      window.pine.pty.detach(paneId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setSearch(null)
      setFindOpen(false)
      setAlternateScreen(false)
      setSuppressedPrompt(null)
      setPendingPaste(null)
    }
  }, [workspaceId, paneId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontStack(font.family)
    term.options.fontSize = font.size
    term.options.fontWeight = font.weight as FontWeight
    term.options.lineHeight = font.lineHeight
    if (!safeFit(hostRef.current, fitRef.current)) return
    const { cols, rows } = term
    const last = lastSizeRef.current
    if (cols > 0 && rows > 0 && (cols !== last.cols || rows !== last.rows)) {
      lastSizeRef.current = { cols, rows }
      window.pine.pty.resize(paneId, cols, rows)
    }
  }, [font.family, font.size, font.weight, font.lineHeight, paneId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
  }, [cursorStyle, cursorBlink])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalPalette(themeId)
  }, [themeId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.scrollSensitivity = scrollSpeed
    term.options.scrollback = scrollbackLines
    term.options.minimumContrastRatio = minimumContrast
  }, [scrollSpeed, scrollbackLines, minimumContrast])

  const closePasteDialog = (): void => {
    setPendingPaste(null)
    termRef.current?.focus()
  }

  const submitInput = (text: string): boolean => {
    if (!canTypeInto(paneId)) return false
    setSuppressedPrompt(useBlocksStore.getState().drafts[paneId]?.promptLine ?? null)
    if (text) return insertCommand(paneId, text, true)
    termRef.current?.focus()
    window.pine.pty.write(paneId, '\r')
    return true
  }

  const palette = terminalPalette(themeId)
  const background = palette.background

  return (
    <div ref={surfaceRef} className="terminal-surface">
      <div className="terminal-stack">
        <div ref={hostRef} className="xterm-host" style={{ background }} />
        <Blocks paneId={paneId} termRef={termRef} hostRef={hostRef} />
        {findOpen && search && (
          <TerminalFind
            search={search}
            options={searchOptions}
            onClose={() => {
              setFindOpen(false)
              termRef.current?.focus()
            }}
          />
        )}
      </div>
      <RiskyPasteDialog
        text={pendingPaste}
        onPaste={(text) => {
          pasteRef.current(text)
          closePasteDialog()
        }}
        onCancel={closePasteDialog}
      />
      <InputEditor
        paneId={paneId}
        cwd={cwd}
        fontFamily={fontStack(font.family)}
        fontSize={font.size}
        palette={palette}
        alternateScreen={alternateScreen}
        suppressedPrompt={suppressedPrompt}
        ownsFocus={() => {
          const active = document.activeElement
          return Boolean(active && surfaceRef.current?.contains(active))
        }}
        onSubmit={submitInput}
        onEscape={() => termRef.current?.focus()}
      />
    </div>
  )
}

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

function decodeOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data)
  return m ? m[1] : null
}

function safeFit(host: HTMLElement | null, fit: FitAddon | null): boolean {
  if (!fit || !host || host.offsetWidth === 0 || host.offsetHeight === 0) return false
  try {
    fit.fit()
    return true
  } catch {
    return false
  }
}
