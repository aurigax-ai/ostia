import type { HistoryMatch } from '@shared/terminal/scrollbackHistory'
import { copyTextConfirmed } from '@/lib/capture/copyConfirm'
import { terminalKeyData } from '@/lib/keyboard/keyPresets'
import type { TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import { isMac } from '@/platform'
import { type HistoryTarget, useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import { createLayerPane, type LayerPane } from './historyLayerPane'
import { lineAtRow, logicalLinesFrom, rowOfLine, WINDOW_LINES, windowStart } from './historyPages'
import { createHistoryScrollbar, type HistoryScrollbar } from './historyScrollbar'
import type { OstiaTerminal, TerminalOptions } from './ostiaTerminal'
import { readOnlyCopyKey } from './readOnlyTerminal'
import { inputEditorFor } from './terminalHandles'

const NO_HISTORY_MS = 1000
const RESET_TERMINAL = '\x1bc'
const FALLBACK_CELL_PX = 17
const REFRESH_MS = 500
const KEEP_LAYER_MS = 3000
const IME_KEYS = new Set(['Process', 'Unidentified'])
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])
const EDIT_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])

interface Info {
  first: number
  end: number
}

interface Page {
  from: number
  count: number
}

interface LoadOptions {
  select?: HistoryMatch
  scrollBy?: number
  follow?: boolean
}

interface Request {
  pick: (info: Info) => number
  options: LoadOptions
}

interface Layer {
  box: HTMLElement
  panes: LayerPane[]
  shown: number
}

export interface HistoryScroll {
  interceptWheel: (e: WheelEvent) => boolean
  scrollLines: (amount: number) => void
  scrollPages: (count: number) => void
  scrollToTop: () => void
  scrollToBottom: () => void
  dispose: () => void
}

export interface HistoryScrollDeps {
  host: HTMLElement
  paneId: string
  term: OstiaTerminal
  engine: TerminalRenderer
  options: () => TerminalOptions
  pause: (paused: boolean) => void
  shown: () => boolean
}

function isTypedKey(e: KeyboardEvent): boolean {
  if (IME_KEYS.has(e.key)) return true
  if (MODIFIER_KEYS.has(e.key) || e.metaKey) return false
  if (e.ctrlKey || e.altKey) return e.key.length === 1 && !(e.ctrlKey && e.shiftKey)
  return e.key.length === 1 || EDIT_KEYS.has(e.key)
}

export function createHistoryScroll(deps: HistoryScrollDeps): HistoryScroll {
  const { host, paneId, term, engine, pause, shown } = deps
  const stack = host.closest<HTMLElement>('.terminal-stack') ?? host.parentElement ?? host
  let alive = true
  let layer: Layer | null = null
  let page: Page | null = null
  let info: Info | null = null
  let infoAt = 0
  let seam = 0
  let epoch = 0
  let engaged = false
  let busy = false
  let queued: Request | null = null
  let refreshing = false
  let handing = false
  let noHistoryUntil = 0
  let dropTimer = 0
  let bar: HistoryScrollbar | null = null

  const liveBuffer = (): OstiaTerminal['buffer']['normal'] => term.buffer.normal

  const readInfo = async (): Promise<Info | null> => {
    const read = await window.ostia.pty.historyRead(paneId, 0, 0)
    if (!alive || !read) return null
    info = { first: read.first, end: read.end }
    infoAt = Date.now()
    seam = read.end - logicalLinesFrom(liveBuffer(), 0)
    return info
  }

  const visible = (): LayerPane | null => (layer ? (layer.panes[layer.shown] ?? null) : null)

  const layerTop = (): number => {
    const pane = visible()
    if (!pane || !page) return seam
    const buf = pane.term.buffer.active
    return page.from + lineAtRow(buf, buf.viewportY)
  }

  const hasHistory = (): boolean => info !== null && seam > info.first

  const updateBar = (): void => {
    if (!info || !hasHistory()) return
    if (!bar) {
      stack.dataset.historyScroll = ''
      if (engine === 'ghostty') term.options.nativeScrollbar = false
      bar = createHistoryScrollbar(stack, seek)
    }
    const rows = term.rows
    const total = seam - info.first + liveBuffer().length
    if (layer) layer.box.dataset.top = String(layerTop())
    const top = engaged ? layerTop() - info.first : seam - info.first + term.buffer.active.viewportY
    const room = Math.max(1, total - rows)
    bar.update(top / room, rows / total)
  }

  const focusLive = (): void => {
    const editor = inputEditorFor(paneId)
    if (editor) editor.focus()
    else term.focus()
  }

  const copyLayerSelection = (e: KeyboardEvent): boolean => {
    const pane = visible()
    if (!pane?.term.hasSelection() || !readOnlyCopyKey(e, true)) return false
    e.preventDefault()
    e.stopPropagation()
    void copyTextConfirmed(paneId, pane.term.getSelection())
    return true
  }

  const notAlternate = (): boolean => term.buffer.active.type === 'normal'

  const ensureLayer = (): Layer | null => {
    window.clearTimeout(dropTimer)
    if (layer) {
      for (const pane of layer.panes) pane.term.resize(term.cols, term.rows)
      return layer
    }
    const box = document.createElement('div')
    box.className = 'history-layer'
    stack.appendChild(box)
    const panes: LayerPane[] = []
    for (let i = 0; i < 2; i++) {
      const pane = createLayerPane(
        engine,
        box,
        { cols: term.cols, rows: term.rows },
        deps.options(),
      )
      if (!pane) {
        for (const made of panes) made.dispose()
        box.remove()
        return null
      }
      pane.el.style.visibility = 'hidden'
      pane.term.onScroll(() => onLayerScroll(pane))
      pane.el.addEventListener('focusin', () => queueMicrotask(focusLive))
      panes.push(pane)
    }
    layer = { box, panes, shown: 0 }
    return layer
  }

  const dropLayer = (): void => {
    if (!layer || engaged) return
    for (const pane of layer.panes) pane.dispose()
    layer.box.remove()
    layer = null
    page = null
  }

  const leave = (to: 'bottom' | number): void => {
    epoch++
    queued = null
    if (!engaged) return
    engaged = false
    if (layer) layer.box.style.visibility = 'hidden'
    if (shown()) pause(false)
    if (to === 'bottom') term.scrollToBottom()
    else term.scrollToLine(to)
    if (layer?.box.contains(document.activeElement)) focusLive()
    updateBar()
    window.clearTimeout(dropTimer)
    dropTimer = window.setTimeout(dropLayer, KEEP_LAYER_MS)
  }

  const load = async (request: Request): Promise<void> => {
    if (busy) {
      const prior = queued?.options.scrollBy ?? 0
      queued = {
        pick: request.pick,
        options: {
          ...request.options,
          scrollBy: (request.options.scrollBy ?? 0) + prior,
        },
      }
      return
    }
    if (!notAlternate()) return
    busy = true
    const started = epoch
    const stale = (): boolean => !alive || epoch !== started || !notAlternate()
    try {
      const read = await readInfo()
      if (stale()) return
      if (!read || (!engaged && seam <= read.first)) {
        if (!engaged) noHistoryUntil = Date.now() + NO_HISTORY_MS
        return
      }
      const target = ensureLayer()
      if (!target) return
      const anchor = Math.max(read.first, request.options.follow ? layerTop() : request.pick(read))
      const from = windowStart(anchor, read.first, read.end)
      const next = await window.ostia.pty.historyRead(paneId, from, WINDOW_LINES)
      if (!next || layer !== target || stale()) return
      const hidden = target.panes[1 - target.shown]
      if (!hidden) return
      const t = hidden.term
      await new Promise<void>((done) => t.write(RESET_TERMINAL + next.lines.join('\r\n'), done))
      if (layer !== target || stale()) return
      const keep = request.options.follow ? layerTop() : anchor
      const buf = t.buffer.active
      t.scrollToLine(rowOfLine(buf, Math.max(0, keep - next.from)))
      const match = request.options.select
      if (match && match.line >= next.from && match.line < next.from + next.lines.length) {
        const row = rowOfLine(buf, match.line - next.from) + Math.floor(match.start / t.cols)
        t.select(match.start % t.cols, row, match.end - match.start)
      }
      if (request.options.scrollBy) t.scrollLines(request.options.scrollBy)
      const shownPane = target.panes[target.shown]
      if (shownPane) shownPane.el.style.visibility = 'hidden'
      hidden.el.style.visibility = ''
      target.shown = 1 - target.shown
      page = { from: next.from, count: next.lines.length }
      info = { first: next.first, end: next.end }
      target.box.style.visibility = 'visible'
      if (!engaged) {
        engaged = true
        pause(true)
      }
      updateBar()
    } finally {
      busy = false
      const waiting = queued
      queued = null
      if (waiting && alive) void load(waiting)
    }
  }

  const handBack = async (): Promise<void> => {
    if (handing) return
    handing = true
    try {
      await readInfo()
      if (!engaged) return
      const top = layerTop()
      if (top >= seam) leave(rowOfLine(liveBuffer(), Math.max(0, top - seam)))
    } finally {
      handing = false
    }
  }

  function onLayerScroll(pane: LayerPane): void {
    if (!engaged || pane !== visible() || busy || !page) return
    const buf = pane.term.buffer.active
    const top = layerTop()
    updateBar()
    if (top >= seam) {
      void handBack()
      return
    }
    const rows = term.rows
    const atEarlier = buf.viewportY < rows && page.from > (info?.first ?? 0)
    const atLater =
      buf.viewportY + 2 * rows >= buf.length && page.from + page.count < (info?.end ?? 0)
    if (atEarlier || atLater) void load({ pick: () => top, options: { follow: true } })
    else if (top + 2 * rows >= seam && Date.now() - infoAt > REFRESH_MS) void readInfo()
  }

  function seek(position: number): void {
    if (!info) return
    const rows = term.rows
    const total = seam - info.first + liveBuffer().length
    const line = info.first + position * Math.max(1, total - rows)
    if (line >= seam) {
      const row = Math.round(line - seam)
      if (engaged) leave(row)
      else term.scrollToLine(row)
      return
    }
    const pane = visible()
    if (engaged && pane && page && line >= page.from && line + rows < page.from + page.count) {
      pane.term.scrollToLine(rowOfLine(pane.term.buffer.active, line - page.from))
      return
    }
    void load({ pick: () => line, options: {} })
  }

  const atLiveTop = (): boolean => {
    const buf = term.buffer.active
    return buf.type === 'normal' && buf.viewportY === 0 && term.modes.mouseTrackingMode === 'none'
  }

  const upFromLiveTop = (lines: number): void =>
    void load({ pick: () => seam, options: { scrollBy: lines } })

  const scrollLines = (amount: number): void => {
    const pane = visible()
    if (engaged && pane) pane.term.scrollLines(amount)
    else if (amount < 0 && atLiveTop() && Date.now() >= noHistoryUntil) upFromLiveTop(amount)
    else term.scrollLines(amount)
  }

  const open = (target: HistoryTarget): void => {
    const third = Math.floor(term.rows / 3)
    if (target.kind === 'aboveLive') {
      void load({ pick: () => seam - term.rows, options: {} })
      return
    }
    const select = target.kind === 'match' ? target.find.matches[target.find.index] : undefined
    const line = target.kind === 'line' ? target.line : (select?.line ?? 0)
    void load({ pick: () => line - third, options: { select } })
  }

  const unsubscribe = useHistoryViewStore.subscribe((state) => {
    const target = state.open[paneId]
    if (!target) return
    state.close(paneId)
    open(target)
  })

  const onKeyDown = (e: KeyboardEvent): void => {
    if (engaged) {
      if (copyLayerSelection(e)) return
      if (isTypedKey(e)) {
        leave('bottom')
        return
      }
    }
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    if (term.buffer.active.type !== 'normal' || terminalKeyData(e, isMac)) return
    e.preventDefault()
    e.stopPropagation()
    scrollLines((e.key === 'PageUp' ? -1 : 1) * term.rows)
  }
  stack.addEventListener('keydown', onKeyDown, true)
  const onComposition = (): void => leave('bottom')
  stack.addEventListener('compositionstart', onComposition, true)

  const paste = term.paste.bind(term)
  const input = term.input.bind(term)
  term.paste = (data) => {
    leave('bottom')
    paste(data)
  }
  term.input = (data, wasUserInput) => {
    if (wasUserInput) leave('bottom')
    input(data, wasUserInput)
  }

  const subscriptions = [
    term.onScroll(() => {
      if (engaged) return
      const buf = term.buffer.active
      if (buf.type !== 'normal' || buf.viewportY >= buf.baseY) return
      if (Date.now() - infoAt > REFRESH_MS && !refreshing) {
        refreshing = true
        void readInfo().then(() => {
          refreshing = false
          updateBar()
        })
      } else updateBar()
    }),
    term.onResize(({ cols, rows }) => {
      for (const pane of layer?.panes ?? []) pane.term.resize(cols, rows)
    }),
    term.buffer.onBufferChange((buffer) => {
      if (buffer.type === 'alternate') leave('bottom')
    }),
  ]

  return {
    interceptWheel: (e) => {
      if (engaged || e.deltaY >= 0 || e.shiftKey || e.ctrlKey || e.metaKey) return false
      if (!atLiveTop() || Date.now() < noHistoryUntil) return false
      const cell = host.clientHeight / Math.max(1, term.rows) || FALLBACK_CELL_PX
      const lines =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY
          : -Math.max(1, Math.round(Math.abs(e.deltaY) / cell))
      upFromLiveTop(lines)
      return true
    },
    scrollLines,
    scrollPages: (count) => scrollLines(count * term.rows),
    scrollToTop: () => {
      const started = epoch
      void load({ pick: (read) => read.first, options: {} }).then(() => {
        if (!engaged && epoch === started) term.scrollToTop()
      })
    },
    scrollToBottom: () => {
      if (engaged) leave('bottom')
      else term.scrollToBottom()
    },
    dispose: () => {
      alive = false
      unsubscribe()
      stack.removeEventListener('keydown', onKeyDown, true)
      stack.removeEventListener('compositionstart', onComposition, true)
      for (const sub of subscriptions) sub.dispose()
      term.paste = paste
      term.input = input
      window.clearTimeout(dropTimer)
      engaged = false
      dropLayer()
      bar?.dispose()
      delete stack.dataset.historyScroll
    },
  }
}
