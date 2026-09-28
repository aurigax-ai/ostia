import type { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import type { ITheme } from '@xterm/xterm'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { IconButton } from './IconButton'

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
  onClose,
}: {
  search: SearchAddon
  options: ISearchOptions
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    const sub = search.onDidChangeResults((r) =>
      setResults({ index: r.resultIndex, count: r.resultCount }),
    )
    return () => {
      sub.dispose()
      search.clearDecorations()
    }
  }, [search])

  const next = (): void => {
    if (query) search.findNext(query, options)
  }
  const prev = (): void => {
    if (query) search.findPrevious(query, options)
  }

  const onChange = (value: string): void => {
    setQuery(value)
    if (value) search.findNext(value, { ...options, incremental: true })
    else {
      search.clearDecorations()
      setResults(null)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
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
    <div className="term-find">
      <input
        ref={inputRef}
        className="term-find-input"
        aria-label={d.find.label}
        placeholder={d.find.placeholder}
        spellCheck={false}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="term-find-count" aria-live="polite">
        {status}
      </span>
      <IconButton icon={ChevronUp} label={d.find.previous} onClick={prev} />
      <IconButton icon={ChevronDown} label={d.find.next} onClick={next} />
      <IconButton icon={X} label={d.find.close} onClick={onClose} />
    </div>
  )
}
