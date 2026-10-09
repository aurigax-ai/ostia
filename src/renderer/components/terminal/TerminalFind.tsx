import { FindBar, type FindStepRef } from '@/components/common/FindBar'
import { useDict } from '@/i18n/useDict'
import type { TerminalSearch } from '@/lib/ostiaTerminal'
import type { ISearchOptions } from '@xterm/addon-search'
import type { ITheme } from '@xterm/xterm'
import { useEffect, useState } from 'react'

export function findOptions(palette: ITheme): ISearchOptions {
  const match = palette.brightBlack ?? '#5c6266'
  const active = palette.yellow ?? '#cfd77c'
  return {
    decorations: {
      matchBackground: match,
      matchOverviewRuler: match,
      activeMatchBackground: palette.blue ?? '#538bb5',
      activeMatchBorder: active,
      activeMatchColorOverviewRuler: active,
    },
  }
}

export function TerminalFind({
  search,
  options,
  stepRef,
  onClose,
}: {
  search: TerminalSearch
  options: ISearchOptions
  stepRef?: FindStepRef
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)

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
    />
  )
}
