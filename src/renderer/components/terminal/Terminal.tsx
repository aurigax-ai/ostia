import type { TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import { silenceQueryReplies } from '@/lib/terminal/tmuxQueries'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AssistComposer } from '@/components/assist/AssistComposer'
import { RiskyPasteDialog } from '@/components/common/RiskyPasteDialog'
import { InputEditor } from '@/components/prompt/InputEditor'
import { attachWheelZoom } from '@/lib/app/wheelZoom'
import { forgetPaneActivity } from '@/lib/attention/paneActivity'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { acceptsPathDrop, droppedPaths, pathsAsInput } from '@/lib/keyboard/dropPaths'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { measureCells } from '@/lib/prompt/usePromptGeometry'
import { ghosttyModule, loadGhostty } from '@/lib/terminal/ghosttyEngine'
import {
  type OstiaTerminal,
  type PauseTerminal,
  type TerminalOptions,
  type TerminalSearch,
  terminalScreen,
} from '@/lib/terminal/ostiaTerminal'
import { TERMINAL_INPUT_SELECTOR } from '@/lib/terminal/ostiaTerminal'
import { attachSmoothScroll } from '@/lib/terminal/smoothScroll'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { keepDrawing, usePauseWhenHidden } from '@/lib/terminal/usePauseWhenHidden'
import { type WebglRenderer, createWebglRenderer } from '@/lib/terminal/webglRenderer'
import { attachWheelReports } from '@/lib/terminal/wheelReports'
import { xtermLinkHandler } from '@/lib/terminalLinks/terminalAppLinks'
import { useScheme } from '@/lib/theme/colorScheme'
import { terminalFontStack } from '@/lib/theme/uiFonts'
import { isLinux, isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Blocks } from './Blocks'
import { TerminalFind, findOptions } from './TerminalFind'
import { type LinkHintBox, TerminalLinkHint } from './TerminalLinkHint'
import { TerminalMenu } from './TerminalMenu'
import { terminalInputBridge } from './terminalInputBridge'
import { attachTerminalKeys } from './terminalKeys'
import { type TerminalLinks, createTerminalLinks } from './terminalLinks'
import { createTerminalPaste } from './terminalPaste'
import { type TerminalFit, attachPtySession } from './terminalPtySession'
import { createTerminalSession } from './terminalSession'
import { createShellIntegration } from './terminalShellIntegration'
import { attachTerminalSignals } from './terminalSignals'
import { initialTerminalOptions, useTerminalOptions } from './useTerminalOptions'
import { useTerminalSelectionSend } from './useTerminalSelectionSend'

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
  const pasteRef = useRef<(text: string) => void>(() => {})
  const pasteClipboardRef = useRef<() => void>(() => {})
  const [pendingPaste, setPendingPaste] = useState<string | null>(null)
  const [search, setSearch] = useState<TerminalSearch | null>(null)
  const [linkHint, setLinkHint] = useState<LinkHintBox | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const findStepRef = useRef<((by: number) => void) | null>(null)
  const [alternateScreen, setAlternateScreen] = useState(false)
  const shown = usePaneVisible(paneId)
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
  const selectionSend = useTerminalSelectionSend({ workspaceId, paneId, cwd, termRef })

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

  usePauseWhenHidden(pauseRef, shown, paneId, engine)
  useTerminalOptions({ termRef, syncSizeRef, font, palette })
  const input = terminalInputBridge({ paneId, termRef, setSuppressedPrompt })

  const closePasteDialog = (): void => {
    setPendingPaste(null)
    termRef.current?.focus()
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

interface StartTerminalDeps {
  host: HTMLElement
  engine: TerminalRenderer
  paneId: string
  workspaceIdRef: { current: string }
  spawnCwd: { current: string | undefined }
  termRef: { current: OstiaTerminal | null }
  pauseRef: { current: PauseTerminal }
  lastSizeRef: { current: { cols: number; rows: number } }
  syncSizeRef: { current: () => void }
  pasteRef: { current: (text: string) => void }
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
    gpuAcceleration: useSettingsStore.getState().behavior.gpuAcceleration,
    links,
  })
  const { term } = created
  if (created.pause) pauseRef.current = created.pause
  attachWheelReports(term, () => measureCells(host, term)?.height ?? 0, isLinux)
  const detachWheelZoom = attachWheelZoom(host, 'terminal', isMac)
  const detachSmoothScroll = attachSmoothScroll(host, term, isMac)
  const screenElement = terminalScreen(host)
  const detachLinks = links.attach(term, screenElement)
  termRef.current = term
  setSearch(created.search)
  const unregisterTerminal = registerTerminal(paneId, term)
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
  const shell = createShellIntegration({ term, paneId, workspaceIdRef, session })
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
    unregisterTerminal()
    forgetPaneActivity(paneId)
    useBlocksStore.getState().dropPane(paneId)
    window.ostia.pty.detach(paneId)
    pauseRef.current = keepDrawing
    created.webgl?.dispose()
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
  webgl: WebglRenderer | null
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
  let webgl: WebglRenderer | null = null
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
    if (gpuAcceleration) {
      webgl = createWebglRenderer(xterm)
      pause = webgl.pause
    }
    term = xterm
    fit = xtermFit
    silenceReplies = () => silenceQueryReplies(xterm)
  }
  if (ghostty) term.open(host)
  return { term, fit, search: searchAddon, webgl, silenceReplies, pause }
}
