import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  WINDOW_LINES,
  earlierStart,
  laterStart,
  lineAtRow,
  rowOfLine,
  windowStart,
} from '@/lib/terminal/historyPages'
import {
  type ReadOnlyTerminal,
  mountReadOnlyTerminal,
  useReadOnlyTerminalBackground,
  useReadOnlyTerminalFont,
} from '@/lib/terminal/readOnlyTerminal'
import { type HistoryTarget, useHistoryViewStore } from '@/stores/terminal/historyViewStore'
import { CaretDownIcon, CaretUpIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react'
import type { HistoryMatch } from '@shared/terminal/scrollbackHistory'
import { useEffect, useRef, useState } from 'react'

interface Page {
  from: number
  count: number
  first: number
  end: number
}

interface HistoryNavigator {
  open: (target: HistoryTarget) => void
  oldest: () => void
}

interface Position {
  line: number
  total: number
}

function isTypedKey(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter')
}

function startHistoryTerminal(
  host: HTMLElement,
  paneId: string,
  close: () => void,
  setPosition: (position: Position) => void,
): { term: ReadOnlyTerminal; navigator: HistoryNavigator; dispose: () => void } {
  const { term, dispose } = mountReadOnlyTerminal(host, { scrollback: WINDOW_LINES * 4 }, (e) => {
    if (e.key === 'Escape' || isTypedKey(e)) {
      e.preventDefault()
      close()
    }
  })
  let live = true
  let page: Page | null = null
  let loading = false

  const report = (): void => {
    if (!page) return
    const buf = term.buffer.active
    setPosition({
      line: page.from - page.first + lineAtRow(buf, buf.viewportY) + 1,
      total: page.end - page.first,
    })
  }

  const show = async (from: number, anchor: number, select?: HistoryMatch): Promise<void> => {
    if (loading) return
    loading = true
    const next = await window.ostia.pty.historyRead(paneId, from, WINDOW_LINES)
    if (!live || !next) {
      loading = false
      return
    }
    const shown: Page = {
      from: next.from,
      count: next.lines.length,
      first: next.first,
      end: next.end,
    }
    page = shown
    term.reset()
    term.write(next.lines.join('\r\n'), () => {
      loading = false
      if (!live) return
      const buf = term.buffer.active
      term.scrollToLine(rowOfLine(buf, Math.max(0, anchor - shown.from)))
      if (select && select.line >= shown.from && select.line < shown.from + shown.count) {
        const row = rowOfLine(buf, select.line - shown.from) + Math.floor(select.start / term.cols)
        term.select(select.start % term.cols, row, select.end - select.start)
      }
      report()
    })
  }

  const open = async (target: HistoryTarget): Promise<void> => {
    const info = await window.ostia.pty.historyRead(paneId, 0, 0)
    if (!live || !info) return
    const third = Math.floor(term.rows / 3)
    const select = target.kind === 'match' ? target.find.matches[target.find.index] : undefined
    const anchor =
      target.kind === 'aboveLive'
        ? info.end - target.liveLines - term.rows
        : (target.kind === 'line' ? target.line : (select?.line ?? info.end)) - third
    const top = Math.max(info.first, anchor)
    await show(windowStart(top, info.first, info.end), top, select)
  }

  const scrolled = term.onScroll(() => {
    report()
    if (!page || loading) return
    const buf = term.buffer.active
    const top = page.from + lineAtRow(buf, buf.viewportY)
    if (buf.viewportY < term.rows && page.from > page.first) {
      void show(earlierStart(page.from, page.first), top)
    } else if (buf.viewportY + 2 * term.rows >= buf.length && page.from + page.count < page.end) {
      void show(laterStart(page.from, page.first, page.end), top)
    }
  })
  term.attachCustomWheelEventHandler((e) => {
    const buf = term.buffer.active
    const atEnd = page !== null && page.from + page.count >= page.end
    if (e.deltaY > 0 && atEnd && buf.viewportY >= buf.baseY) close()
    return true
  })
  term.focus()

  return {
    term,
    navigator: {
      open: (target) => void open(target),
      oldest: () => {
        if (page) void show(page.first, page.first)
      },
    },
    dispose: () => {
      live = false
      scrolled.dispose()
      dispose()
    },
  }
}

export function HistoryView({
  paneId,
  target,
  onClose,
}: {
  paneId: string
  target: HistoryTarget
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<ReadOnlyTerminal | null>(null)
  const navigatorRef = useRef<HistoryNavigator | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const background = useReadOnlyTerminalBackground(termRef)
  useReadOnlyTerminalFont(termRef)
  const [position, setPosition] = useState<Position | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const started = startHistoryTerminal(host, paneId, () => closeRef.current(), setPosition)
    termRef.current = started.term
    navigatorRef.current = started.navigator
    return () => {
      navigatorRef.current = null
      termRef.current = null
      started.dispose()
    }
  }, [paneId])

  useEffect(() => {
    navigatorRef.current?.open(target)
  }, [target])

  const find = target.kind === 'match' ? target.find : null
  const step = (by: number): void => {
    if (!find) return
    const index = Math.min(find.matches.length - 1, Math.max(0, find.index + by))
    if (index !== find.index) {
      useHistoryViewStore.getState().show(paneId, { kind: 'match', find: { ...find, index } })
    }
  }

  return (
    <div
      className="history-view"
      data-history=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="history-bar">
        <ClockCounterClockwiseIcon aria-hidden className="size-4 shrink-0 text-fg-muted" />
        <span className="text-ui-sm text-fg">{d.scrollHistory.title}</span>
        {position ? (
          <span className="text-ui-xs text-fg-muted tabular-nums">
            {fmt(d.scrollHistory.position, {
              line: position.line.toLocaleString(),
              total: position.total.toLocaleString(),
            })}
          </span>
        ) : null}
        <span className="flex-1" />
        {find && find.matches.length > 0 ? (
          <>
            <span className="text-ui-xs text-fg-muted tabular-nums">
              {fmt(d.scrollHistory.match, { index: find.index + 1, count: find.matches.length })}
            </span>
            <IconButton
              icon={CaretUpIcon}
              label={d.scrollHistory.previousMatch}
              disabled={find.index === 0}
              onClick={() => step(-1)}
            />
            <IconButton
              icon={CaretDownIcon}
              label={d.scrollHistory.nextMatch}
              disabled={find.index === find.matches.length - 1}
              onClick={() => step(1)}
            />
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigatorRef.current?.oldest()
            termRef.current?.focus()
          }}
        >
          {d.scrollHistory.oldest}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          {d.scrollHistory.live}
        </Button>
      </div>
      <div ref={hostRef} className="xterm-host history-screen" style={{ background }} />
    </div>
  )
}
