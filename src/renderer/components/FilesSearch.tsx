import {
  AsteriskIcon,
  MagnifyingGlassIcon,
  TextAaIcon,
  TextUnderlineIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { SearchNameHit, SearchOutcome } from '@shared/search'
import type { FsEntry } from '@shared/types'
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { childPath } from '../lib/fileTree'
import { openFileAt, openFileInWorkspace } from '../lib/openFile'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { fileIcon } from './fileIcon'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'

export const SEARCH_DELAY_MS = 200

export interface SearchToggles {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

const NO_TOGGLES: SearchToggles = { caseSensitive: false, wholeWord: false, regex: false }

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; outcome: SearchOutcome }

function useSearch(root: string, text: string, toggles: SearchToggles): SearchState {
  const includeIgnored = useSettingsStore((s) => s.files.searchIgnored)
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const { caseSensitive, wholeWord, regex } = toggles
  useEffect(() => {
    if (!text.trim()) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    setState((current) => (current.status === 'done' ? current : { status: 'searching' }))
    const timer = setTimeout(() => {
      void window.ostia.search
        .run({ root, text, caseSensitive, wholeWord, regex, includeIgnored })
        .then((outcome) => {
          if (!alive || (!outcome.ok && outcome.error === 'cancelled')) return
          setState({ status: 'done', outcome })
        })
    }, SEARCH_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [root, text, caseSensitive, wholeWord, regex, includeIgnored])
  return state
}

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }): JSX.Element {
  const parts: ReactNode[] = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark key={from} className="search-mark">
        {text.slice(from, to)}
      </mark>,
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function positionRanges(positions: number[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const pos of positions) {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === pos) last[1] = pos + 1
    else ranges.push([pos, pos + 1])
  }
  return ranges
}

function NameRow({
  hit,
  root,
  onReveal,
}: {
  hit: SearchNameHit
  root: string
  onReveal: (path: string) => void
}): JSX.Element {
  const full = childPath(root, hit.path)
  const entry: FsEntry = { name: hit.path.split('/').pop() ?? hit.path, dir: hit.dir }
  const { Icon, color } = fileIcon(entry, false)
  return (
    <button
      type="button"
      className="file-row search-row"
      onClick={() => (hit.dir ? onReveal(full) : openFileInWorkspace(full))}
    >
      <Icon size={16} className="file-icon" style={{ color }} />
      <span className="file-name">
        <Highlighted text={hit.path} ranges={positionRanges(hit.positions)} />
      </span>
    </button>
  )
}

function SearchResults({
  state,
  isHidden,
  onReveal,
}: {
  state: SearchState
  isHidden: (path: string) => boolean
  onReveal: (path: string) => void
}): JSX.Element | null {
  const d = useDict()
  if (state.status === 'idle') return null
  if (state.status === 'searching') {
    return <div className="search-status">{d.filesView.searching}</div>
  }
  const { outcome } = state
  if (!outcome.ok) {
    const message =
      outcome.error === 'invalid-pattern' ? d.filesView.searchInvalid : d.filesView.searchFailed
    return (
      <div className="search-status" role="alert">
        {message}
      </div>
    )
  }
  const { root } = outcome.results
  const names = outcome.results.names.filter((h) => !isHidden(childPath(root, h.path)))
  const files = outcome.results.files.filter((f) => !isHidden(childPath(root, f.path)))
  const matches = files.reduce((n, f) => n + f.matches.length, 0)
  if (names.length === 0 && files.length === 0) {
    return <div className="search-status">{d.filesView.searchNoResults}</div>
  }
  return (
    <div className="file-tree search-results">
      {names.length > 0 ? (
        <section aria-label={d.filesView.searchNames}>
          <div className="search-group">
            <span className="search-group-title">{d.filesView.searchNames}</span>
          </div>
          {names.map((hit) => (
            <NameRow key={hit.path} hit={hit} root={root} onReveal={onReveal} />
          ))}
        </section>
      ) : null}
      {files.length > 0 ? (
        <section aria-label={d.filesView.searchText}>
          <div className="search-group">
            <span className="search-group-title">{d.filesView.searchText}</span>
            <span>
              {fmt(matches === 1 ? d.filesView.searchSummaryOne : d.filesView.searchSummaryMany, {
                count: String(matches),
                files: String(files.length),
              })}
            </span>
          </div>
          {files.map((file) => {
            const full = childPath(root, file.path)
            const entry: FsEntry = { name: file.path.split('/').pop() ?? file.path, dir: false }
            const { Icon, color } = fileIcon(entry, false)
            return (
              <div key={file.path} className="search-file">
                <button
                  type="button"
                  className="file-row search-row"
                  onClick={() => openFileInWorkspace(full)}
                >
                  <Icon size={16} className="file-icon" style={{ color }} />
                  <span className="file-name">{file.path}</span>
                </button>
                {file.matches.map((m) => (
                  <button
                    key={`${m.line}:${m.column}`}
                    type="button"
                    className="file-row search-line"
                    onClick={() => openFileAt(full, m.line, m.column)}
                  >
                    <span className="search-line-number">{m.line}</span>
                    <span className="file-name">
                      <Highlighted text={m.text} ranges={m.ranges} />
                    </span>
                  </button>
                ))}
              </div>
            )
          })}
          {outcome.results.truncated ? (
            <div className="search-status">{d.filesView.searchTruncated}</div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

export function FilesSearch({
  root,
  isHidden,
  onReveal,
  children,
}: {
  root: string
  isHidden: (path: string) => boolean
  onReveal: (path: string) => void
  children: ReactNode
}): JSX.Element {
  const d = useDict()
  const [text, setText] = useState('')
  const [toggles, setToggles] = useState<SearchToggles>(NO_TOGGLES)
  const state = useSearch(root, text, toggles)
  const toggle = (key: keyof SearchToggles): void => setToggles((t) => ({ ...t, [key]: !t[key] }))
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && text) {
      e.preventDefault()
      setText('')
    }
  }
  const reveal = (path: string): void => {
    setText('')
    onReveal(path)
  }
  return (
    <>
      <div className="files-search">
        <InputGroup className="h-7">
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            className="files-search-input text-ui-sm md:text-ui-sm"
            aria-label={d.filesView.search}
            placeholder={d.filesView.searchPlaceholder}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="inline-end" className="gap-0">
            {text ? (
              <IconButton
                icon={XIcon}
                label={d.filesView.searchClear}
                onClick={() => setText('')}
              />
            ) : null}
            <IconButton
              icon={TextAaIcon}
              label={d.filesView.matchCase}
              aria-pressed={toggles.caseSensitive}
              onClick={() => toggle('caseSensitive')}
            />
            <IconButton
              icon={TextUnderlineIcon}
              label={d.filesView.wholeWord}
              aria-pressed={toggles.wholeWord}
              onClick={() => toggle('wholeWord')}
            />
            <IconButton
              icon={AsteriskIcon}
              label={d.filesView.useRegex}
              aria-pressed={toggles.regex}
              onClick={() => toggle('regex')}
            />
          </InputGroupAddon>
        </InputGroup>
      </div>
      {text.trim() ? (
        <SearchResults state={state} isHidden={isHidden} onReveal={reveal} />
      ) : (
        children
      )}
    </>
  )
}
