import type { HistorySearchResult } from '@shared/terminal/scrollbackHistory'
import type { ISearchOptions } from '@xterm/addon-search'
import { useEffect, useRef, useState } from 'react'
import { FindBar, type FindStepRef } from '@/components/common/FindBar'
import { TextLink } from '@/components/common/TextLink'
import { fmt, useDict } from '@/lib/app/useDict'
import type { TerminalSearch } from '@/lib/terminal/ostiaTerminal'
import type { TerminalColors } from '@/lib/theme/types'
import type { HistoryFind } from '@/stores/terminal/historyViewStore'

export function findOptions(palette: TerminalColors): ISearchOptions {
  const match = palette.brightBlack
  const active = palette.yellow
  return {
    decorations: {
      matchBackground: match,
      matchOverviewRuler: match,
      activeMatchBackground: palette.blue,
      activeMatchBorder: active,
      activeMatchColorOverviewRuler: active,
    },
  }
}

const EARLIER_SEARCH_DELAY_MS = 150

function useEarlierMatches(
  paneId: string,
  query: string,
  liveLines: () => number,
): HistorySearchResult | null {
  const [earlier, setEarlier] = useState<HistorySearchResult | null>(null)
  const liveLinesRef = useRef(liveLines)
  liveLinesRef.current = liveLines
  useEffect(() => {
    setEarlier(null)
    if (!query) return
    let live = true
    const timer = setTimeout(() => {
      void window.ostia.pty
        .historySearch(paneId, query, {}, liveLinesRef.current())
        .then((result) => {
          if (live) setEarlier(result)
        })
    }, EARLIER_SEARCH_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [paneId, query])
  return earlier
}

export function TerminalFind({
  paneId,
  search,
  options,
  stepRef,
  liveLines,
  onShowEarlier,
  onClose,
}: {
  paneId: string
  search: TerminalSearch
  options: ISearchOptions
  stepRef?: FindStepRef
  liveLines: () => number
  onShowEarlier: (find: HistoryFind) => void
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const earlier = useEarlierMatches(paneId, query, liveLines)

  useEffect(() => {
    const sub = search.onDidChangeResults((r) =>
      setResults({ index: r.resultIndex, count: r.resultCount }),
    )
    return () => {
      sub.dispose()
      search.clearDecorations()
    }
  }, [search])

  const step = (by: number): void => {
    if (!query) return
    if (by < 0) search.findPrevious(query, options)
    else search.findNext(query, options)
  }

  const onQuery = (value: string): void => {
    setQuery(value)
    if (value) search.findNext(value, { ...options, incremental: true })
    else {
      search.clearDecorations()
      setResults(null)
    }
  }

  const status =
    !query || !results
      ? ''
      : results.count === 0
        ? d.find.noResults
        : results.index < 0
          ? `${results.count}`
          : `${results.index + 1}/${results.count}`

  return (
    <FindBar
      label={d.find.label}
      query={query}
      status={status}
      onQuery={onQuery}
      onStep={step}
      onClose={onClose}
      stepRef={stepRef}
      extra={
        earlier && earlier.count > 0 ? (
          <TextLink
            size="xs"
            className="text-ui-xs tabular-nums"
            title={d.find.earlierHint}
            onClick={() =>
              onShowEarlier({
                query,
                options: {},
                matches: earlier.matches,
                index: earlier.matches.length - 1,
              })
            }
          >
            {fmt(d.find.earlier, { count: earlier.count.toLocaleString() })}
          </TextLink>
        ) : null
      }
    />
  )
}
