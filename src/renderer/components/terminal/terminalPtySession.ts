import type { HumanInputSource } from '@shared/terminal/ptyApi'
import { keptShellReattached } from '@/lib/agents/autoResume'
import { keptAgentReattached } from '@/lib/agents/paneAgent'
import { markPaneActivity } from '@/lib/attention/paneActivity'
import { spawnPromptOption } from '@/lib/prompt/promptChips'
import { humanInputSource } from '@/lib/terminal/humanInput'
import { type NeighbourQueue, neighbourWrites } from '@/lib/terminal/neighbourWrites'
import {
  noteFittedGrid,
  offscreenGrid,
  registerOffscreenStarter,
} from '@/lib/terminal/offscreenStart'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { commitShellTitle } from '@/lib/terminal/paneTitle'
import { releasePhoneHold } from '@/lib/terminal/phoneHold'
import { createPtyAcker } from '@/lib/terminal/ptyAck'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { usePhoneSizeStore } from '@/stores/terminal/phoneSizeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { TerminalSession } from './terminalSession'
import { isPromptRepaint, nextSizeAction, settleFit } from './terminalSizing'

const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O'])
const UNDRAWN_START_MS = 1000

export interface TerminalFit {
  fit(): void
  proposeDimensions(): { cols: number; rows: number } | undefined
}

interface PtyFlow {
  attached: boolean
  replayed: boolean
  unparsed: number
  querySilencer: { dispose(): void } | null
}

type Write = (data: string, done?: () => void) => void

interface PtySessionDeps {
  host: HTMLElement
  term: OstiaTerminal
  fit: TerminalFit
  screenElement: HTMLElement | null
  paneId: string
  workspaceIdRef: { current: string }
  spawnCwd: { current: string | undefined }
  lastSizeRef: { current: { cols: number; rows: number } }
  syncSizeRef: { current: () => void }
  session: TerminalSession
  anchor: () => LineAnchor
  disposeMarkers: () => void
  silenceReplies: () => { dispose(): void }
  holdInput: (data: string, source: HumanInputSource | undefined) => boolean
}

interface PtyIo {
  flow: PtyFlow
  pending: string[]
  writeOutput: Write
  writeLive: Write
  neighbour: NeighbourQueue
}

export function attachPtySession(deps: PtySessionDeps): () => void {
  const { host, term, paneId, workspaceIdRef, lastSizeRef, syncSizeRef, session, holdInput } = deps
  const flow: PtyFlow = { attached: false, replayed: false, unparsed: 0, querySilencer: null }
  const pending: string[] = []
  const emit: Write = (data, done) => {
    flow.unparsed++
    term.write(data, () => {
      flow.unparsed--
      done?.()
    })
  }
  const acker = createPtyAcker((chars) => window.ostia.pty.ack(paneId, chars))
  const neighbour = neighbourWrites.queue((data, chunks) => {
    flow.unparsed -= chunks
    emit(data, () => acker.written(data.length))
  })
  const writeOutput: Write = (data, done) => {
    neighbour.drain()
    emit(data, done)
  }
  const isActive = (): boolean => {
    const active = useLayoutStore.getState().byWorkspace[workspaceIdRef.current]?.activePaneId
    return active === undefined || active === paneId
  }
  const writeLive: Write = (data, done) => {
    writeOutput(data, () => {
      acker.written(data.length)
      done?.()
    })
  }
  markPaneActivity(paneId)
  const offData = window.ostia.pty.onData(paneId, (d) => {
    markPaneActivity(paneId)
    if (!flow.replayed) pending.push(d)
    else if (!sizing.hold(d)) {
      if (isActive()) {
        neighbourWrites.noteFocusedWrite()
        writeLive(d)
      } else {
        flow.unparsed++
        neighbour.push(d)
      }
    }
  })
  const offExit = window.ostia.pty.onExit(paneId, (_code, closes) => {
    neighbour.drain()
    term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
    if (closes || useSandboxStore.getState().hostPanes[paneId]) {
      useLayoutStore.getState().closePane(workspaceIdRef.current, paneId)
    }
  })

  const io: PtyIo = { flow, pending, writeOutput, writeLive, neighbour }
  const phoneSize = usePhoneSizeStore.getState()
  const applyHeld = (cols: number, rows: number, held: boolean): void => {
    if (session.disposed) return
    neighbour.drain()
    term.resize(cols, rows)
    lastSizeRef.current = { cols, rows }
    sizing.holdBox(held ? { w: host.offsetWidth, h: host.offsetHeight } : null)
    if (held) phoneSize.hold(paneId, { cols, useDesktop: sizing.takeBack })
    else phoneSize.release(paneId)
  }
  const attachAtCurrentSize = createPtyAttach(deps, io, applyHeld)
  const sizing = createPtySizing(deps, io, attachAtCurrentSize)

  const offSize = window.ostia.pty.onSize(paneId, (cols, rows, held) => {
    if (held || usePhoneSizeStore.getState().byPane[paneId]) applyHeld(cols, rows, held)
  })
  const mouse = (): void => {
    if (term.modes.mouseTrackingMode !== 'none') releasePhoneHold(paneId)
  }
  host.addEventListener('mousedown', mouse, true)

  const input = term.onData((d) => {
    const source = humanInputSource(host)
    if (!holdInput(d, source)) window.ostia.pty.write(paneId, d, source)
    if (!FOCUS_REPORTS.has(d)) markPaneActivity(paneId)
    if (!FOCUS_REPORTS.has(d) && useBlocksStore.getState().selected[paneId]) {
      useBlocksStore.getState().select(paneId, null)
    }
    if (useAttentionStore.getState().byPane[paneId]?.state === 'waiting') {
      useAttentionStore.getState().dispatch(paneId, { type: 'input', at: Date.now() })
    }
  })

  syncSizeRef.current = () => {
    if (flow.attached) sizing.syncSize()
  }
  let undrawnStart: ReturnType<typeof setTimeout> | null = null
  const startOffscreenNow = (keepSize: boolean | undefined): void => {
    if (keepSize) {
      attachAtCurrentSize(0, 0)
      return
    }
    const grid = offscreenGrid()
    term.resize(grid.cols, grid.rows)
    attachAtCurrentSize(grid.cols, grid.rows)
  }
  const unregisterOffscreen = registerOffscreenStarter(paneId, ({ keepSize }) => {
    if (flow.attached || session.disposed) return
    if (host.offsetWidth === 0 || host.offsetHeight === 0) {
      startOffscreenNow(keepSize)
      return
    }
    if (undrawnStart) clearTimeout(undrawnStart)
    undrawnStart = setTimeout(() => {
      undrawnStart = null
      if (flow.attached || session.disposed) return
      sizing.applyFit()
      if (!flow.attached) startOffscreenNow(keepSize)
    }, UNDRAWN_START_MS)
  })

  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let rafId = 0
  const ro = new ResizeObserver(() => {
    if (!flow.attached) {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(sizing.syncSize)
      return
    }
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      rafId = requestAnimationFrame(sizing.syncSize)
    }, 90)
  })
  ro.observe(host)
  if (deps.screenElement) ro.observe(deps.screenElement)

  return () => {
    unregisterOffscreen()
    if (undrawnStart) clearTimeout(undrawnStart)
    flow.querySilencer?.dispose()
    syncSizeRef.current = () => {}
    if (resizeTimer) clearTimeout(resizeTimer)
    if (rafId) cancelAnimationFrame(rafId)
    sizing.dispose()
    ro.disconnect()
    input.dispose()
    offSize()
    host.removeEventListener('mousedown', mouse, true)
    phoneSize.release(paneId)
    offData()
    offExit()
    neighbour.dispose()
  }
}

function createPtyAttach(
  {
    term,
    paneId,
    workspaceIdRef,
    spawnCwd,
    lastSizeRef,
    session,
    anchor,
    disposeMarkers,
    silenceReplies,
  }: PtySessionDeps,
  { flow, pending, writeOutput, writeLive }: PtyIo,
  applyHeld: (cols: number, rows: number, held: boolean) => void,
): (cols: number, rows: number) => void {
  return (cols, rows) => {
    flow.attached = true
    lastSizeRef.current = { cols, rows }
    const flushPending = (): void => {
      flow.replayed = true
      for (const d of pending) writeLive(d)
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
      .then((result) => {
        const {
          buffer,
          sandboxed,
          sandboxStamp,
          host,
          shell,
          kept,
          reattached,
          agentRunning,
          cwdMissing,
          markNonce,
        } = result
        if (session.disposed) return
        session.markNonce = markNonce ?? null
        if (result.held && result.cols && result.rows) {
          applyHeld(result.cols, result.rows, true)
        } else if (lastSizeRef.current.cols === 0 && result.cols && result.rows) {
          term.resize(result.cols, result.rows)
          lastSizeRef.current = { cols: result.cols, rows: result.rows }
        }
        useLayoutStore
          .getState()
          .settleSpawnDir(workspaceIdRef.current, paneId, cwdMissing === true)
        if (kept && !flow.querySilencer) flow.querySilencer = silenceReplies()
        if (reattached) keptShellReattached(workspaceIdRef.current, paneId)
        commitShellTitle(workspaceIdRef.current, paneId, shell)
        useSandboxStore.getState().notePane(paneId, sandboxed ?? false, sandboxStamp)
        if (host) useSandboxStore.getState().noteHost(paneId)
        disposeMarkers()
        useBlocksStore.getState().resetPane(paneId)
        session.blockSeq = result.blockSeqBase ?? 0
        const reopenKeptAgent = (): void => {
          if (agentRunning && !session.disposed) {
            keptAgentReattached(workspaceIdRef.current, paneId, anchor())
          }
        }
        if (buffer) {
          session.replaying = true
          writeOutput(buffer, () => {
            session.replaying = false
            reopenKeptAgent()
          })
        } else {
          reopenKeptAgent()
        }
        flushPending()
      })
      .catch((err: unknown) => {
        if (session.disposed) return
        const reason = err instanceof Error ? err.message : String(err)
        term.writeln(`\x1b[2m[failed to start shell: ${reason}]\x1b[0m`)
        flushPending()
      })
  }
}

interface PtySizing {
  hold: (data: string) => boolean
  applyFit: () => void
  syncSize: () => void
  holdBox: (box: { w: number; h: number } | null) => void
  takeBack: () => void
  dispose: () => void
}

function createPtySizing(
  { host, term, fit, screenElement, paneId, lastSizeRef, session }: PtySessionDeps,
  { flow, writeOutput, writeLive, neighbour }: PtyIo,
  attachAtCurrentSize: (cols: number, rows: number) => void,
): PtySizing {
  let holdForRedraw = false
  let held: string[] = []
  let holdIdleTimer: ReturnType<typeof setTimeout> | null = null
  let holdCapTimer: ReturnType<typeof setTimeout> | null = null
  let holdEraseRow = 1
  let holdCursor = { row: 1, col: 1 }
  let holdDims = { cols: 0, rows: 0 }
  let awaitingParse = false
  let parseAwaited = false

  const hold = (data: string): boolean => {
    if (!holdForRedraw) return false
    held.push(data)
    if (holdIdleTimer) clearTimeout(holdIdleTimer)
    holdIdleTimer = setTimeout(flushHold, 24)
    return true
  }

  const applyFit = (): void => {
    const fitted = safeFit(host, fit, term)
    const { cols, rows } = term
    const action = nextSizeAction({
      fitted,
      attached: flow.attached,
      cols,
      rows,
      last: lastSizeRef.current,
    })
    if (action.type !== 'none') noteFittedGrid(action.cols, action.rows)
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
    if (session.disposed) return
    const redraw = held.join('')
    held = []
    const { cols, rows } = holdDims
    if (redraw.length > 0 && isPromptRepaint(redraw)) {
      const restore = `\x1b[${holdCursor.row};${holdCursor.col}H`
      writeOutput(`\x1b[${holdEraseRow};1H\x1b[0J${restore}`, () => {
        if (session.disposed) return
        term.resize(cols, rows)
        writeLive(redraw)
        syncSize()
      })
    } else {
      term.resize(cols, rows)
      if (redraw.length > 0) writeLive(redraw)
      syncSize()
    }
  }
  let heldBox: { w: number; h: number } | null = null
  const syncSize = (): void => {
    if (holdForRedraw || awaitingParse) return
    if (heldBox) {
      if (host.offsetWidth === heldBox.w && host.offsetHeight === heldBox.h) return
      heldBox = null
    }
    if (flow.attached && screenElement && !screenElement.isConnected) return
    if (flow.attached && host && fit && host.offsetWidth > 0 && host.offsetHeight > 0) {
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
        if (draft && !blocks.running[paneId] && flow.unparsed > 0 && !parseAwaited) {
          awaitingParse = true
          neighbour.drain()
          term.write('', () => {
            awaitingParse = false
            if (session.disposed) return
            parseAwaited = true
            syncSize()
            parseAwaited = false
          })
          return
        }
        if (draft && !blocks.running[paneId] && flow.unparsed === 0) {
          const marker = session.promptMarker
          const markLine = marker && !marker.isDisposed ? marker.line : -1
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

  return {
    hold,
    applyFit,
    syncSize,
    holdBox: (box) => {
      heldBox = box
    },
    takeBack: () => {
      heldBox = null
      syncSize()
    },
    dispose: () => {
      if (holdIdleTimer) clearTimeout(holdIdleTimer)
      if (holdCapTimer) clearTimeout(holdCapTimer)
    },
  }
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
