import { CHAT_CONTEXT_TEXT_MAX } from '@shared/assist'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type FontWeight, type IBufferRange, Terminal as Xterm } from '@xterm/xterm'
import { keptShellReattached } from '../lib/autoResume'
import { silenceQueryReplies } from '../lib/tmuxQueries'
import type { TerminalRenderer } from '../settings/terminalPaneSettings'
import '@xterm/xterm/css/xterm.css'
import { isNativeClipboardKey } from '@shared/chordSpec'
import { useEffect, useMemo, useRef, useState } from 'react'
import { wantsDesktopBanner } from '../../shared/notificationSettings'
import { commands } from '../commands/registry'
import { currentDict, fmt } from '../i18n/useDict'
import { tail } from '../lib/askContext'
import {
  KittyNotificationAssembler,
  type OscNotification,
  notificationMessage,
  parseOsc9,
  parseOsc99,
  parseOsc777,
} from '../lib/attention'
import { bellActions, createBellThrottle } from '../lib/bell'
import { canTypeInto, insertCommand, selectedBlockOutput, stepBlock } from '../lib/blockActions'
import { decodeCommandLine, readCommandText } from '../lib/blockText'
import { openBrowserAs } from '../lib/browserProfile'
import {
  execChord,
  findStep,
  isAppChord,
  isBrowserChord,
  isTerminalCommandChord,
  matchChord,
  matchTerminalChord,
} from '../lib/chords'
import {
  PROGRAM_PASTE_KEY,
  keyPastePlan,
  pasteEventReadsClipboard,
  smartClipboardAction,
} from '../lib/clipboardKeys'
import { currentScheme, terminalTheme, useScheme } from '../lib/colorScheme'
import { acceptsPathDrop, droppedPaths, pathsAsInput } from '../lib/dropPaths'
import { ghosttyModule, loadGhostty } from '../lib/ghosttyEngine'
import { terminalKeyData } from '../lib/keyPresets'
import {
  type LinkKind,
  attachLinkClaim,
  attachLinkModifier,
  linkModifierHeld,
  linkSpan,
  linkTarget,
} from '../lib/linkModifier'
import { openFileAt } from '../lib/openFile'
import { isLocalHost, parseOsc7 } from '../lib/osc7'
import { registerOsc52 } from '../lib/osc52'
import {
  type OstiaTerminal,
  type TerminalMarker,
  type TerminalOptions,
  type TerminalSearch,
  type WebLinkHandler,
  terminalScreen,
} from '../lib/ostiaTerminal'
import { forgetPaneActivity, markPaneActivity } from '../lib/paneActivity'
import { terminalNotification } from '../lib/paneAgent'
import { commitProgramTitle, commitShellTitle } from '../lib/paneTitle'
import { planDraftPaste, planHumanPaste } from '../lib/pasteGate'
import { installPrimarySelection } from '../lib/primarySelection'
import { spawnPromptOption } from '../lib/promptChips'
import { scrollUpSequence } from '../lib/promptOverlay'
import { registerSelectionSender } from '../lib/selectionSenders'
import { createFileLinkProvider } from '../lib/terminalFileLinks'
import { inputEditorFor, registerTerminal } from '../lib/terminalHandles'
import { terminalTitle } from '../lib/terminalTitle'
import { createTitleCommitter } from '../lib/titleCommit'
import { terminalFontStack } from '../lib/uiFonts'
import { measureCells } from '../lib/usePromptGeometry'
import { loadWebglRenderer } from '../lib/webglRenderer'
import { attachWheelReports } from '../lib/wheelReports'
import { attachWheelZoom } from '../lib/wheelZoom'
import {
  isPaneViewed,
  isPaneVisible,
  shouldNotifyCommandEnd,
  signalPane,
} from '../lib/workspaceActivity'
import { isLinux, isMac } from '../platform'
import { useAttentionStore } from '../stores/attentionStore'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useLiveSelectionStore } from '../stores/liveSelectionStore'
import { useRemoteCwdStore } from '../stores/remoteCwdStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { AssistComposer } from './AssistComposer'
import { Blocks } from './Blocks'
import { InputEditor } from './InputEditor'
import { RiskyPasteDialog } from './RiskyPasteDialog'
import { useSelectionSend } from './SelectionSend'
import { TerminalFind, findOptions } from './TerminalFind'
import { type LinkHintBox, TerminalLinkHint } from './TerminalLinkHint'
import { TerminalMenu } from './TerminalMenu'
import { isPromptRepaint, nextSizeAction, settleFit } from './terminalSizing'

const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O'])
const LINK_HINT_DELAY_MS = 400

interface TerminalViewProps {
  workspaceId: string
  paneId: string
  cwd?: string
}

interface TerminalFit {
  fit(): void
  proposeDimensions(): { cols: number; rows: number } | undefined
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const [engine] = useState<TerminalRenderer>(() => useSettingsStore.getState().terminal.renderer)
  const [ready, setReady] = useState(() => engine !== 'ghostty' || ghosttyModule() !== null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (ready) return
    let live = true
    loadGhostty()
      .then(() => {
        if (live) setReady(true)
      })
      .catch((err: unknown) => {
        if (live) setFailure(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [ready])
  if (failure) {
    return (
      <div className="terminal-surface">
        <p role="alert" className="ghostty-failure text-fg-muted text-ui-sm">
          {fmt(currentDict().settings.ghosttyFailed, { reason: failure })}
        </p>
      </div>
    )
  }
  if (!ready) return <div className="terminal-surface" />
  return <TerminalSurface engine={engine} {...props} />
}

function TerminalSurface({
  engine,
  workspaceId,
  paneId,
  cwd,
}: TerminalViewProps & { engine: TerminalRenderer }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<OstiaTerminal | null>(null)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const syncSizeRef = useRef<() => void>(() => {})
  const spawnCwd = useRef(cwd)
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const font = useSettingsStore((s) => s.appearance.terminal)
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const palette = useScheme('terminal').colors
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const macOptionIsMeta = useSettingsStore((s) => s.terminal.macOptionIsMeta)
  const pasteRef = useRef<(text: string) => void>(() => {})
  const pasteClipboardRef = useRef<() => void>(() => {})
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)
  const [search, setSearch] = useState<TerminalSearch | null>(null)
  const [linkHint, setLinkHint] = useState<LinkHintBox | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const findStepRef = useRef<((by: number) => void) | null>(null)
  const [alternateScreen, setAlternateScreen] = useState(false)
  const [suppressedPrompt, setSuppressedPrompt] = useState<LineAnchor | null>(null)
  const searchOptions = useMemo(() => findOptions(palette), [palette])
  const selectionSend = useSelectionSend(workspaceId, paneId)
  const sendSelectionRef = useRef<() => void>(() => {})
  sendSelectionRef.current = () => {
    const selected = termRef.current?.getSelection() ?? ''
    const block = selected.trim() ? null : selectedBlockOutput(paneId)
    const text = block ? block.output : selected
    if (!text.trim()) {
      selectionSend.notify(currentDict().viewer.noTerminalSelection)
      return
    }
    selectionSend.open({
      kind: 'terminal',
      cwd: cwd ?? null,
      command: block?.command || null,
      text,
    })
  }

  useEffect(() => registerSelectionSender(paneId, () => sendSelectionRef.current()), [paneId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useSettingsStore.getState().appearance.terminal
    const behavior = useSettingsStore.getState().behavior
    const terminalSettings = useSettingsStore.getState().terminal
    const options: TerminalOptions = {
      theme: terminalTheme(currentScheme('terminal').colors),
      fontFamily: terminalFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: initial.weight as FontWeight,
      lineHeight: initial.lineHeight,
      cursorStyle: behavior.cursorStyle,
      cursorBlink: behavior.cursorBlink,
      scrollback: terminalSettings.scrollbackLines,
      scrollSensitivity: terminalSettings.scrollSpeed,
      minimumContrastRatio: terminalSettings.minimumContrast,
      macOptionIsMeta: terminalSettings.macOptionIsMeta,
    }
    let term: OstiaTerminal
    let fit: TerminalFit
    let hoveredLink = false
    let linkHintTimer: ReturnType<typeof setTimeout> | null = null
    const showLinkHint = (kind: LinkKind, range: IBufferRange): void => {
      hoveredLink = true
      if (linkHintTimer) clearTimeout(linkHintTimer)
      linkHintTimer = setTimeout(() => {
        const cells = measureCells(host, term)
        if (!cells) return
        const span = linkSpan(range, term.buffer.active.viewportY, term.cols)
        setLinkHint({
          kind,
          left: cells.left + span.start * cells.width,
          top: cells.top + span.row * cells.height,
          width: (span.end - span.start) * cells.width,
          height: cells.height,
        })
      }, LINK_HINT_DELAY_MS)
    }
    const hideLinkHint = (): void => {
      hoveredLink = false
      if (linkHintTimer) clearTimeout(linkHintTimer)
      linkHintTimer = null
      setLinkHint(null)
    }
    const openWebLink = (e: MouseEvent, uri: string): void => {
      if (!linkModifierHeld(e, isMac)) return
      if (linkTarget(useSettingsStore.getState().browser.openTerminalLinks, e) === 'pane') {
        openBrowserAs(workspaceIdRef.current, uri, 'human')
      } else {
        window.open(uri, '_blank')
      }
    }
    const webLinks: WebLinkHandler = {
      activate: openWebLink,
      hover: (_e, _text, range) => showLinkHint('web', range),
      leave: hideLinkHint,
    }
    let searchAddon: TerminalSearch | null = null
    let silenceReplies: () => { dispose(): void }
    const ghostty = engine === 'ghostty' ? ghosttyModule() : null
    if (ghostty) {
      const created = ghostty.createGhosttyTerminal(options, behavior.gpuAcceleration, webLinks)
      term = created.term
      fit = created.fit
      searchAddon = created.search
      silenceReplies = created.silenceQueryReplies
    } else {
      const xterm = new Xterm({ ...options, allowProposedApi: true })
      const xtermFit = new FitAddon()
      xterm.loadAddon(xtermFit)
      xterm.loadAddon(new Unicode11Addon())
      xterm.unicode.activeVersion = '11'
      xterm.options.linkHandler = webLinks
      xterm.loadAddon(
        new WebLinksAddon(openWebLink, {
          hover: (_e, _text, range) => showLinkHint('web', range),
          leave: hideLinkHint,
        }),
      )
      const xtermSearch = new SearchAddon()
      xterm.loadAddon(xtermSearch)
      searchAddon = xtermSearch
      xterm.open(host)
      if (behavior.gpuAcceleration) loadWebglRenderer(xterm)
      term = xterm
      fit = xtermFit
      silenceReplies = () => silenceQueryReplies(xterm)
    }
    if (ghostty) term.open(host)
    attachWheelReports(term, () => measureCells(host, term)?.height ?? 0, isLinux)
    const detachWheelZoom = attachWheelZoom(host, 'terminal', isMac)
    const detachLinkModifier = attachLinkModifier(host, isMac)
    const linkScreen = terminalScreen(host)
    const detachLinkClaim = linkScreen
      ? attachLinkClaim(linkScreen, (e) => hoveredLink && linkModifierHeld(e, isMac))
      : () => {}
    termRef.current = term
    setSearch(searchAddon)
    const unregisterTerminal = registerTerminal(paneId, term)
    const pasteConfirmed = (text: string): void => {
      const editor = inputEditorFor(paneId)
      if (editor) editor.type(text)
      else term.paste(text)
    }
    pasteRef.current = pasteConfirmed
    const planPaste = (text: string) =>
      planHumanPaste(text, useSettingsStore.getState().terminal.warnOnRiskyPaste)
    const requestPaste = (text: string): void => {
      if (disposed) return
      const editor = inputEditorFor(paneId)
      if (editor) {
        const draft = planDraftPaste(text)
        if (draft) editor.type(draft)
        return
      }
      const plan = planPaste(text)
      if (plan.confirm) setPendingPaste(plan.text)
      else if (plan.text) pasteConfirmed(plan.text)
    }
    const pasteFromClipboard = async (): Promise<void> => {
      const text = await navigator.clipboard.readText().catch(() => '')
      if (disposed) return
      const editorShown = Boolean(inputEditorFor(paneId))
      const hasImage =
        !text && !editorShown && (await window.ostia.clipboard.hasImage().catch(() => false))
      if (disposed) return
      const plan = keyPastePlan(text, editorShown, hasImage)
      if (plan === 'text') requestPaste(text)
      else if (plan === 'program') term.input(PROGRAM_PASTE_KEY, true)
    }
    pasteClipboardRef.current = () => void pasteFromClipboard()
    const interceptPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (pasteEventReadsClipboard(text, Boolean(inputEditorFor(paneId)), isMac)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        void pasteFromClipboard()
        return
      }
      if (!inputEditorFor(paneId)) {
        const plan = planPaste(text)
        if (!plan.confirm && plan.text === text) return
      }
      e.preventDefault()
      e.stopImmediatePropagation()
      requestPaste(text)
    }
    host.addEventListener('paste', interceptPaste, true)
    const focusEditorOnClick = (e: MouseEvent): void => {
      if (e.button !== 0 || term.hasSelection()) return
      inputEditorFor(paneId)?.focus()
    }
    host.addEventListener('mouseup', focusEditorOnClick)
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
      const smart = smartClipboardAction(
        e,
        useSettingsStore.getState().terminal.clipboardKeys,
        term.hasSelection(),
        isMac,
      )
      if (smart) {
        if (e.type !== 'keydown') return false
        e.preventDefault()
        if (smart === 'copy') {
          void navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
        } else {
          void pasteFromClipboard()
        }
        return false
      }
      const scoped = matchTerminalChord(e, isMac)
      if (scoped && e.type === 'keydown') e.stopPropagation()
      if (isAppChord(scoped)) {
        if (e.type === 'keydown') {
          e.preventDefault()
          execChord(scoped, e)
        }
        return false
      }
      const chord = scoped ?? matchChord(e, isMac)
      if (!chord || isBrowserChord(chord)) {
        const sent = terminalKeyData(e, isMac)
        if (sent && !inputEditorFor(paneId)) {
          if (e.type === 'keydown') {
            e.preventDefault()
            term.input(sent, true)
          }
          return false
        }
        if (chord) return true
        const editor = inputEditorFor(paneId)
        if (!editor) return true
        if (e.type !== 'keydown') return false
        e.preventDefault()
        const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
        if (printable) editor.type(e.key)
        else editor.focus()
        return false
      }
      const clipboard = chord === 'copy' || chord === 'paste'
      if (isMac && clipboard && isNativeClipboardKey(e)) return true
      if (e.type !== 'keydown' || isAppChord(chord)) return false
      e.preventDefault()
      const findBy = findStep(chord)
      if (chord === 'find') setFindOpen(true)
      else if (findBy !== null) {
        if (findStepRef.current) findStepRef.current(findBy)
        else setFindOpen(true)
      } else if (chord === 'block.selectPrev') stepBlock(paneId, 'prev')
      else if (chord === 'block.selectNext') stepBlock(paneId, 'next')
      else if (isTerminalCommandChord(chord)) void commands.exec(chord)
      else if (chord === 'copy') {
        const selection = term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
      } else {
        void pasteFromClipboard()
      }
      return false
    })

    const cwdRef = { current: spawnCwd.current ?? null }
    let remote = false
    let promptMarker: TerminalMarker | undefined
    const markers = new Set<TerminalMarker>()
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
    const onCommandEnd = (exitCode: number, wholeCommand: string | null): void => {
      const blocks = useBlocksStore.getState()
      const runningId = blocks.running[paneId]
      const block = runningId ? blocks.byPane[paneId]?.find((b) => b.id === runningId) : undefined
      blocks.commandEnd(
        paneId,
        anchor(),
        exitCode,
        term.buffer.active.cursorX,
        wholeCommand ?? undefined,
      )
      if (!block || replaying) return
      const long = shouldNotifyCommandEnd(
        Date.now() - block.startedAt,
        document.hasFocus(),
        useSettingsStore.getState().notifications.longCommandSeconds,
      )
      if (isPaneViewed(paneId) || (exitCode === 0 && !long)) {
        useAttentionStore.getState().dispatch(paneId, { type: 'waitEnded', at: Date.now() })
        return
      }
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
        window.ostia.notifications.post({
          paneId,
          kind: exitCode === 0 ? 'done' : 'error',
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
      signalPane(paneId, terminalNotification(paneId, notificationMessage(n), Date.now()))
      window.ostia.notifications.post({
        paneId,
        kind: 'message',
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
    const removePrimarySelection = installPrimarySelection(host, term, {
      enabled: () => isLinux && useSettingsStore.getState().terminal.primarySelection,
      writePrimary: (text) => window.ostia.window.writePrimarySelection(text),
    })
    const oscClipboard = registerOsc52(term, {
      enabled: () => useSettingsStore.getState().terminal.osc52Write,
      replaying: () => replaying,
      write: (text) => navigator.clipboard.writeText(text),
    })
    const fileLinks = term.registerLinkProvider(
      createFileLinkProvider(term, {
        cwd: () => cwdRef.current,
        remote: () => remote,
        stat: (path) => window.ostia.fs.stat(path),
        open: openFileAt,
        modifierHeld: (e) => linkModifierHeld(e, isMac),
        hover: (range) => showLinkHint('file', range),
        leave: hideLinkHint,
      }),
    )
    const copySelection = term.onSelectionChange(() => {
      useLiveSelectionStore
        .getState()
        .report(
          workspaceIdRef.current,
          paneId,
          { kind: 'terminal' },
          tail(term.getSelection(), CHAT_CONTEXT_TEXT_MAX),
        )
      if (!useSettingsStore.getState().behavior.copyOnSelect || !term.hasSelection()) return
      void navigator.clipboard.writeText(term.getSelection())
    })
    const titles = createTitleCommitter((title) =>
      commitProgramTitle(workspaceIdRef.current, paneId, title),
    )
    const titleChange = term.onTitleChange((raw) => {
      const title = terminalTitle(raw)
      if (title) titles.push(title)
    })
    const allowBellSound = createBellThrottle()
    const bell = term.onBell(() => {
      if (replaying) return
      const now = Date.now()
      const act = bellActions(useSettingsStore.getState().notifications.bell, isPaneViewed(paneId))
      if (act.sound && allowBellSound(now)) window.ostia.window.beep()
      if (act.attention) useAttentionStore.getState().dispatch(paneId, { type: 'bell', at: now })
    })
    const oscCwd = term.parser.registerOscHandler(7, (data) => {
      const report = parseOsc7(data)
      if (!report) return true
      remote = !isLocalHost(report.host)
      useRemoteCwdStore
        .getState()
        .report(paneId, remote ? { host: report.host, cwd: report.path } : null)
      if (!remote) {
        cwdRef.current = report.path
        useLayoutStore.getState().setCwd(workspaceIdRef.current, paneId, report.path)
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
        blocks.promptStart(paneId, anchor(), remote ? null : cwdRef.current, remote)
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
      } else if (kind === 'D') {
        const wholeCommand = reportedCommand
        reportedCommand = null
        onCommandEnd(Number(arg ?? 0), wholeCommand)
      }
      return true
    })

    let disposed = false
    let attached = false
    let querySilencer: { dispose(): void } | null = null
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
    const offData = window.ostia.pty.onData(paneId, (d) => {
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
    const offExit = window.ostia.pty.onExit(paneId, (_code, closes) => {
      term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
      if (closes || useSandboxStore.getState().hostPanes[paneId]) {
        useLayoutStore.getState().closePane(workspaceIdRef.current, paneId)
      }
    })

    const attachAtCurrentSize = (cols: number, rows: number): void => {
      attached = true
      lastSizeRef.current = { cols, rows }
      const flushPending = (): void => {
        replayed = true
        for (const d of pending) term.write(d)
        pending.length = 0
      }
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
        .then(({ buffer, sandboxed, sandboxStamp, host, shell, kept, reattached }) => {
          if (disposed) return
          if (kept && !querySilencer) querySilencer = silenceReplies()
          if (reattached) keptShellReattached(workspaceIdRef.current, paneId)
          commitShellTitle(workspaceIdRef.current, paneId, shell)
          useSandboxStore.getState().notePane(paneId, sandboxed ?? false, sandboxStamp)
          if (host) useSandboxStore.getState().noteHost(paneId)
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
      const fitted = safeFit(host, fit, term)
      const { cols, rows } = term
      const action = nextSizeAction({ fitted, attached, cols, rows, last: lastSizeRef.current })
      if (action.type === 'attach') {
        attachAtCurrentSize(action.cols, action.rows)
      } else if (action.type === 'resize') {
        lastSizeRef.current = { cols: action.cols, rows: action.rows }
        window.ostia.pty.resize(paneId, action.cols, action.rows)
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
            window.ostia.pty.resize(paneId, dims.cols, dims.rows)
            holdCapTimer = setTimeout(flushHold, 150)
            return
          }
        }
      }
      applyFit()
    }

    const input = term.onData((d) => {
      window.ostia.pty.write(paneId, d)
      if (!FOCUS_REPORTS.has(d)) markPaneActivity(paneId)
      if (!FOCUS_REPORTS.has(d) && useBlocksStore.getState().selected[paneId]) {
        useBlocksStore.getState().select(paneId, null)
      }
      if (useAttentionStore.getState().byPane[paneId]?.state === 'waiting') {
        useAttentionStore.getState().dispatch(paneId, { type: 'input', at: Date.now() })
      }
    })

    syncSizeRef.current = syncSize
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
      querySilencer?.dispose()
      syncSizeRef.current = () => {}
      if (resizeTimer) clearTimeout(resizeTimer)
      if (rafId) cancelAnimationFrame(rafId)
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      if (holdCapTimer) clearTimeout(holdCapTimer)
      ro.disconnect()
      input.dispose()
      bufferChange.dispose()
      host.removeEventListener('paste', interceptPaste, true)
      host.removeEventListener('mouseup', focusEditorOnClick)
      pasteRef.current = () => {}
      pasteClipboardRef.current = () => {}
      offData()
      offExit()
      oscCwd.dispose()
      useRemoteCwdStore.getState().report(paneId, null)
      oscBlocks.dispose()
      oscCommandLine.dispose()
      oscNotify9.dispose()
      oscNotify777.dispose()
      oscNotify99.dispose()
      oscClipboard.dispose()
      removePrimarySelection()
      bell.dispose()
      copySelection.dispose()
      useLiveSelectionStore.getState().clear(paneId)
      fileLinks.dispose()
      detachWheelZoom()
      detachLinkModifier()
      detachLinkClaim()
      if (linkHintTimer) clearTimeout(linkHintTimer)
      setLinkHint(null)
      titleChange.dispose()
      titles.cancel()
      promptMarker?.dispose()
      disposeMarkers()
      unregisterTerminal()
      forgetPaneActivity(paneId)
      useBlocksStore.getState().dropPane(paneId)
      window.ostia.pty.detach(paneId)
      term.dispose()
      termRef.current = null
      setSearch(null)
      setFindOpen(false)
      setAlternateScreen(false)
      setSuppressedPrompt(null)
      setPendingPaste(null)
    }
  }, [paneId, engine])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack(font.family)
    term.options.fontSize = font.size
    term.options.fontWeight = font.weight as FontWeight
    term.options.lineHeight = font.lineHeight
    syncSizeRef.current()
  }, [font.family, font.size, font.weight, font.lineHeight])

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

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.scrollSensitivity = scrollSpeed
    term.options.scrollback = scrollbackLines
    term.options.minimumContrastRatio = minimumContrast
    term.options.macOptionIsMeta = macOptionIsMeta
  }, [scrollSpeed, scrollbackLines, minimumContrast, macOptionIsMeta])

  const closePasteDialog = (): void => {
    setPendingPaste(null)
    termRef.current?.focus()
  }

  const submitInput = (text: string): boolean => {
    if (!canTypeInto(paneId)) return false
    setSuppressedPrompt(useBlocksStore.getState().drafts[paneId]?.promptLine ?? null)
    if (text) return insertCommand(paneId, text, true)
    termRef.current?.focus()
    window.ostia.pty.write(paneId, '\r')
    return true
  }

  const handOffInput = (draft: string, keys: string): void => {
    const term = termRef.current
    if (!term || !canTypeInto(paneId)) return
    setSuppressedPrompt(useBlocksStore.getState().drafts[paneId]?.promptLine ?? null)
    term.focus()
    if (draft) term.paste(draft)
    if (keys) window.ostia.pty.write(paneId, keys)
  }

  const sendShellKeys = (keys: string): void => {
    if (canTypeInto(paneId)) window.ostia.pty.write(paneId, keys)
  }

  const makeRows = (rows: number): void => {
    const term = termRef.current
    if (!term || rows <= 0) return
    const buf = term.buffer.active
    term.write(scrollUpSequence(term.rows, buf.cursorY, buf.cursorX, rows))
  }

  const background = palette.background

  return (
    <div
      ref={surfaceRef}
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
        <TerminalMenu
          paneId={paneId}
          termRef={termRef}
          onPaste={() => pasteClipboardRef.current()}
          trigger={
            <div
              ref={hostRef}
              className={engine === 'ghostty' ? 'ghostty-host' : 'xterm-host'}
              style={{ background }}
            />
          }
        />
        <Blocks paneId={paneId} termRef={termRef} hostRef={hostRef} />
        <InputEditor
          paneId={paneId}
          cwd={cwd}
          fontFamily={terminalFontStack(font.family)}
          fontSize={font.size}
          palette={palette}
          alternateScreen={alternateScreen}
          suppressedPrompt={suppressedPrompt}
          termRef={termRef}
          hostRef={hostRef}
          ownsFocus={() => {
            const active = document.activeElement
            return Boolean(active && surfaceRef.current?.contains(active))
          }}
          onSubmit={submitInput}
          onHandOff={handOffInput}
          onShellKeys={sendShellKeys}
          onNeedRows={makeRows}
        />
        <AssistComposer paneId={paneId} cwd={cwd} termRef={termRef} />
        <TerminalLinkHint hint={linkHint} />
        {findOpen && search && (
          <TerminalFind
            search={search}
            options={searchOptions}
            stepRef={findStepRef}
            onClose={() => {
              setFindOpen(false)
              termRef.current?.focus()
            }}
          />
        )}
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
      {selectionSend.panel}
      {selectionSend.status}
    </div>
  )
}

function decodeBase64Utf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

function safeFit(host: HTMLElement, fit: TerminalFit, term: OstiaTerminal): boolean {
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return false
  try {
    settleFit(() => {
      fit.fit()
      return { cols: term.cols, rows: term.rows }
    })
    return true
  } catch {
    return false
  }
}
