import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as Xterm } from '@xterm/xterm'
import type { TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import { silenceQueryReplies } from '@/lib/terminal/tmuxQueries'
import '@xterm/xterm/css/xterm.css'
import { type HTMLAttributes, type JSX, useEffect, useMemo, useRef, useState } from 'react'
import { AssistComposer } from '@/components/assist/AssistComposer'
import { CaptureLayer } from '@/components/capture/CaptureLayer'
import { RiskyPasteDialog } from '@/components/common/RiskyPasteDialog'
import { InputEditor } from '@/components/prompt/InputEditor'
import { attachWheelZoom } from '@/lib/app/wheelZoom'
import { forgetPaneActivity } from '@/lib/attention/paneActivity'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { acceptsPathDrop, droppedPaths, pathsAsInput } from '@/lib/keyboard/dropPaths'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { measureCells } from '@/lib/prompt/usePromptGeometry'
import { ghosttyModule, loadGhostty } from '@/lib/terminal/ghosttyEngine'
import { liveLogicalLines } from '@/lib/terminal/historyActions'
import { createHistoryScroll } from '@/lib/terminal/historyScroll'
import {
  type OstiaTerminal,
  type PauseTerminal,
  TERMINAL_INPUT_SELECTOR,
  type TerminalOptions,
  type TerminalSearch,
  terminalScreen,
} from '@/lib/terminal/ostiaTerminal'
import { attachSmoothScroll } from '@/lib/terminal/smoothScroll'
import { drawOnGpu } from '@/lib/terminal/softwareGl'
import { registerHistoryScroll, registerTerminal } from '@/lib/terminal/terminalHandles'
import { keepDrawing, usePauseWhenHidden } from '@/lib/terminal/usePauseWhenHidden'
import { attachWheelReports } from '@/lib/terminal/wheelReports'
import { createXtermRenderer, type XtermRenderer } from '@/lib/terminal/xtermRenderer'
import { xtermLinkHandler } from '@/lib/terminalLinks/terminalAppLinks'
import { useScheme } from '@/lib/theme/colorScheme'
import { terminalFontStack } from '@/lib/theme/uiFonts'
import { isLinux, isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import { Blocks } from './Blocks'
import { findOptions, TerminalFind } from './TerminalFind'
import { type LinkHintBox, TerminalLinkHint } from './TerminalLinkHint'
import { TerminalMenu } from './TerminalMenu'
import { terminalInputBridge } from './terminalInputBridge'
import { attachTerminalKeys } from './terminalKeys'
import { createTerminalLinks, type TerminalLinks } from './terminalLinks'
import { createTerminalPaste } from './terminalPaste'
import { attachPtySession, type TerminalFit } from './terminalPtySession'
import { createTerminalSession } from './terminalSession'
import { createShellIntegration } from './terminalShellIntegration'
import { attachTerminalSignals } from './terminalSignals'
import { useTerminalCapture } from './useTerminalCapture'
import { initialTerminalOptions, useTerminalOptions } from './useTerminalOptions'

interface TerminalViewProps {
  workspaceId: string
  paneId: string
  cwd?: string
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const [engine, setEngine] = useState<TerminalRenderer>(
    () => useSettingsStore.getState().terminal.renderer,
  )
  const [ready, setReady] = useState(() => engine !== 'ghostty' || ghosttyModule() !== null)
  useEffect(() => {
    if (ready) return
    let live = true
    loadGhostty()
      .catch(() => {
        if (live) setEngine('xterm')
      })
      .finally(() => {
        if (live) setReady(true)
      })
    return () => {
      live = false
    }
  }, [ready])
  if (!ready) return <div className="terminal-surface" />
  return <TerminalSurface engine={engine} {...props} />
}

function pathDropHandlers(
  pasteRef: { current: (text: string, reference?: boolean) => void },
  termRef: { current: OstiaTerminal | null },
): Pick<HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDrop'> {
  return {
    onDragOver: (e) => {
      if (!acceptsPathDrop([...e.dataTransfer.types])) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (e) => {
      if (!acceptsPathDrop([...e.dataTransfer.types])) return
      e.preventDefault()
      const text = pathsAsInput(droppedPaths(e.dataTransfer))
      if (!text) return
      pasteRef.current(text, true)
      termRef.current?.focus()
    },
  }
}

function TerminalFindLayer({
  paneId,
  search,
  options,
  stepRef,
  termRef,
  setFindOpen,
}: {
  paneId: string
  search: TerminalSearch
  options: ReturnType<typeof findOptions>
  stepRef: { current: ((by: number) => void) | null }
  termRef: { current: OstiaTerminal | null }
  setFindOpen: (open: boolean) => void
}): JSX.Element {
  return (
    <TerminalFind
      paneId={paneId}
      search={search}
      options={options}
      stepRef={stepRef}
      liveLines={() => (termRef.current ? liveLogicalLines(termRef.current) : 0)}
      onShowEarlier={(find) => {
        setFindOpen(false)
        useHistoryViewStore.getState().show(paneId, { kind: 'match', find })
      }}
      onClose={() => {
        setFindOpen(false)
        termRef.current?.focus()
      }}
    />
  )
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
  const pauseRef = useRef<PauseTerminal>(keepDrawing)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const syncSizeRef = useRef<() => void>(() => {})
  const spawnCwd = useRef(cwd)
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const font = useSettingsStore((s) => s.appearance.terminal)
  const palette = useScheme('terminal').colors
  const pasteRef = useRef<(text: string, reference?: boolean) => void>(() => {})
  const pasteClipboardRef = useRef<() => void>(() => {})
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)
  const [search, setSearch] = useState<TerminalSearch | null>(null)
  const [linkHint, setLinkHint] = useState<LinkHintBox | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const findStepRef = useRef<((by: number) => void) | null>(null)
  const [alternateScreen, setAlternateScreen] = useState(false)
  const shown = usePaneVisible(paneId)
  const shownRef = useRef(shown)
  shownRef.current = shown
  useSurfaceFocus(
    paneId,
    () =>
      surfaceRef.current?.querySelector<HTMLElement>('.input-editor:not([hidden]) textarea') ??
      hostRef.current?.querySelector<HTMLElement>(TERMINAL_INPUT_SELECTOR) ??
      null,
  )
  const dismissLinkHintRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!shown) dismissLinkHintRef.current()
  }, [shown])
  const [suppressedPrompt, setSuppressedPrompt] = useState<LineAnchor | null>(null)
  const searchOptions = useMemo(() => findOptions(palette), [palette])
  useTerminalCapture({ paneId, cwd, termRef, surfaceRef })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return startTerminal({
      host,
      engine,
      paneId,
      workspaceIdRef,
      spawnCwd,
      termRef,
      pauseRef,
      shownRef,
      lastSizeRef,
      syncSizeRef,
      pasteRef,
      pasteClipboardRef,
      dismissLinkHintRef,
      findStepRef,
      setPendingPaste,
      setSearch,
      setLinkHint,
      setFindOpen,
      setAlternateScreen,
      setSuppressedPrompt,
    })
  }, [paneId, engine])

  useEffect(() => () => useHistoryViewStore.getState().close(paneId), [paneId])
  usePauseWhenHidden(pauseRef, syncSizeRef, shown, paneId, engine)
  useTerminalOptions({ termRef, syncSizeRef, font, palette })
  const input = terminalInputBridge({ paneId, termRef, setSuppressedPrompt })

  const closePasteDialog = (): void => {
    setPendingPaste(null)
    termRef.current?.focus()
  }

  const background = palette.background

  return (
    <div ref={surfaceRef} className="terminal-surface" {...pathDropHandlers(pasteRef, termRef)}>
      <div className="terminal-stack" style={{ background }}>
        <TerminalMenu
          paneId={paneId}
          termRef={termRef}
          onPaste={() => pasteClipboardRef.current()}
          trigger={
            <div ref={hostRef} className={engine === 'ghostty' ? 'ghostty-host' : 'xterm-host'} />
          }
        />
        <Blocks paneId={paneId} termRef={termRef} hostRef={hostRef} shown={shown} />
        <InputEditor
          paneId={paneId}
          cwd={cwd}
          fontFamily={terminalFontStack(font.family)}
          fontSize={font.size}
          palette={palette}
          alternateScreen={alternateScreen}
          paneShown={shown}
          suppressedPrompt={suppressedPrompt}
          termRef={termRef}
          hostRef={hostRef}
          ownsFocus={() => {
            const active = document.activeElement
            return Boolean(active && surfaceRef.current?.contains(active))
          }}
          onSubmit={input.submitInput}
          onHandOff={input.handOffInput}
          onShellKeys={input.sendShellKeys}
          onNeedRows={input.makeRows}
        />
        <AssistComposer paneId={paneId} cwd={cwd} termRef={termRef} />
        <TerminalLinkHint hint={shown ? linkHint : null} />
        {findOpen && search && (
          <TerminalFindLayer
            paneId={paneId}
            search={search}
            options={searchOptions}
            stepRef={findStepRef}
            termRef={termRef}
            setFindOpen={setFindOpen}
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
      <CaptureLayer workspaceId={workspaceId} paneId={paneId} visible={shown} />
    </div>
  )
}

interface StartTerminalDeps {
  host: HTMLElement
  engine: TerminalRenderer
  paneId: string
  workspaceIdRef: { current: string }
  spawnCwd: { current: string | undefined }
  termRef: { current: OstiaTerminal | null }
  pauseRef: { current: PauseTerminal }
  shownRef: { current: boolean }
  lastSizeRef: { current: { cols: number; rows: number } }
  syncSizeRef: { current: () => void }
  pasteRef: { current: (text: string, reference?: boolean) => void }
  pasteClipboardRef: { current: () => void }
  dismissLinkHintRef: { current: () => void }
  findStepRef: { current: ((by: number) => void) | null }
  setPendingPaste: (text: string | null) => void
  setSearch: (search: TerminalSearch | null) => void
  setLinkHint: (hint: LinkHintBox | null) => void
  setFindOpen: (open: boolean) => void
  setAlternateScreen: (alternate: boolean) => void
  setSuppressedPrompt: (prompt: LineAnchor | null) => void
}

function startTerminal(deps: StartTerminalDeps): () => void {
  const { host, engine, paneId, workspaceIdRef, termRef, pauseRef, pasteRef, pasteClipboardRef } =
    deps
  const { setPendingPaste, setSearch, setFindOpen, setAlternateScreen } = deps
  const session = createTerminalSession(deps.spawnCwd.current ?? null)
  const links = createTerminalLinks({
    host,
    paneId,
    workspaceIdRef,
    session,
    setLinkHint: deps.setLinkHint,
  })
  deps.dismissLinkHintRef.current = links.dismissHint
  const created = createEngine({
    engine,
    host,
    options: initialTerminalOptions(),
    gpuAcceleration: drawOnGpu(useSettingsStore.getState().behavior.gpuAcceleration),
    links,
  })
  const { term } = created
  if (created.pause) pauseRef.current = created.pause
  const history = createHistoryScroll({
    host,
    paneId,
    term,
    engine,
    options: initialTerminalOptions,
    pause: (paused) => pauseRef.current(paused),
    shown: () => deps.shownRef.current,
  })
  attachWheelReports(
    term,
    () => measureCells(host, term)?.height ?? 0,
    isLinux,
    history.interceptWheel,
  )
  const detachWheelZoom = attachWheelZoom(host, 'terminal', isMac)
  const detachSmoothScroll = attachSmoothScroll(host, term, isMac)
  const screenElement = terminalScreen(host)
  const detachLinks = links.attach(term, screenElement)
  termRef.current = term
  setSearch(created.search)
  const unregisterTerminal = registerTerminal(paneId, term)
  const unregisterHistory = registerHistoryScroll(paneId, history)
  const paste = createTerminalPaste({ host, term, paneId, session, setPendingPaste })
  pasteRef.current = paste.pasteConfirmed
  pasteClipboardRef.current = () => paste.pasteFromClipboard()
  const detachKeys = attachTerminalKeys({
    host,
    term,
    paneId,
    pasteFromClipboard: paste.pasteFromClipboard,
    setFindOpen,
    findStepRef: deps.findStepRef,
  })
  const bufferChange = term.buffer.onBufferChange((buffer) =>
    setAlternateScreen(buffer.type === 'alternate'),
  )
  const shell = createShellIntegration({
    term,
    paneId,
    workspaceIdRef,
    session,
    suppressPrompt: deps.setSuppressedPrompt,
  })
  const detachSignals = attachTerminalSignals({ host, term, paneId, workspaceIdRef, session })
  const unregisterLinks = links.registerProviders()
  const detachPty = attachPtySession({
    host,
    term,
    fit: created.fit,
    screenElement,
    paneId,
    workspaceIdRef,
    spawnCwd: deps.spawnCwd,
    lastSizeRef: deps.lastSizeRef,
    syncSizeRef: deps.syncSizeRef,
    session,
    anchor: shell.anchor,
    disposeMarkers: shell.disposeMarkers,
    silenceReplies: created.silenceReplies,
    holdInput: paste.holdInput,
  })

  return () => {
    session.disposed = true
    detachPty()
    bufferChange.dispose()
    paste.dispose()
    detachKeys()
    pasteRef.current = () => {}
    pasteClipboardRef.current = () => {}
    shell.dispose()
    detachSignals()
    unregisterLinks()
    detachWheelZoom()
    detachSmoothScroll()
    detachLinks()
    unregisterHistory()
    history.dispose()
    unregisterTerminal()
    forgetPaneActivity(paneId)
    useBlocksStore.getState().dropPane(paneId)
    window.ostia.pty.detach(paneId)
    pauseRef.current = keepDrawing
    created.xtermRenderer?.dispose()
    term.dispose()
    termRef.current = null
    setSearch(null)
    setFindOpen(false)
    setAlternateScreen(false)
    deps.setSuppressedPrompt(null)
    setPendingPaste(null)
  }
}

interface TerminalEngine {
  term: OstiaTerminal
  fit: TerminalFit
  search: TerminalSearch | null
  xtermRenderer: XtermRenderer | null
  silenceReplies: () => { dispose(): void }
  pause: PauseTerminal | null
}

function createEngine({
  engine,
  host,
  options,
  gpuAcceleration,
  links: { webLinks, openWebLink, showLinkHint, hideLinkHint },
}: {
  engine: TerminalRenderer
  host: HTMLElement
  options: TerminalOptions
  gpuAcceleration: boolean
  links: TerminalLinks
}): TerminalEngine {
  let term: OstiaTerminal
  let fit: TerminalFit
  let searchAddon: TerminalSearch | null = null
  let xtermRenderer: XtermRenderer | null = null
  let silenceReplies: () => { dispose(): void }
  let pause: PauseTerminal | null = null
  const ghostty = engine === 'ghostty' ? ghosttyModule() : null
  if (ghostty) {
    const created = ghostty.createGhosttyTerminal(options, gpuAcceleration, webLinks)
    term = created.term
    fit = created.fit
    searchAddon = created.search
    silenceReplies = created.silenceQueryReplies
    pause = created.setPaused
  } else {
    const xterm = new Xterm({
      ...options,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: false },
    })
    const xtermFit = new FitAddon()
    xterm.loadAddon(xtermFit)
    xterm.loadAddon(new Unicode11Addon())
    xterm.unicode.activeVersion = '11'
    xterm.options.linkHandler = xtermLinkHandler(webLinks)
    xterm.loadAddon(
      new WebLinksAddon(openWebLink, {
        hover: (_e, uri, range) => showLinkHint('web', range, uri),
        leave: hideLinkHint,
      }),
    )
    const xtermSearch = new SearchAddon()
    xterm.loadAddon(xtermSearch)
    searchAddon = xtermSearch
    xterm.open(host)
    xtermRenderer = createXtermRenderer(xterm, gpuAcceleration)
    pause = xtermRenderer.pause
    term = xterm
    fit = xtermFit
    silenceReplies = () => silenceQueryReplies(xterm)
  }
  if (ghostty) term.open(host)
  return { term, fit, search: searchAddon, xtermRenderer, silenceReplies, pause }
}
