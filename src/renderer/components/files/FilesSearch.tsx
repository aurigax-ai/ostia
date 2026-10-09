import { IconButton } from '@/components/common/IconButton'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { fmt, useDict } from '@/i18n/useDict'
import { childPath } from '@/lib/files/fileTree'
import { openFileAt, openFileInWorkspace } from '@/lib/files/openFile'
import { type PdfSearchResults, searchPdfs } from '@/lib/files/pdfSearch'
import { textMatcher } from '@/lib/files/textMatch'
import { usePdfFindStore } from '@/stores/pdfFindStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import {
  AsteriskIcon,
  MagnifyingGlassIcon,
  TextAaIcon,
  TextUnderlineIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { SearchNameHit, SearchOutcome } from '@shared/search'
import type { FsEntry } from '@shared/types'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { fileIcon } from './fileIcon'

export const SEARCH_DELAY_MS = 200

export interface SearchToggles {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

const NO_TOGGLES: SearchToggles = { caseSensitive: false, wholeWord: false, regex: false }

type PdfState = PdfSearchResults | 'searching' | null

type SearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'done'; outcome: SearchOutcome; pdf: PdfState }

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
        .then(async (outcome) => {
          if (!alive || (!outcome.ok && outcome.error === 'cancelled')) return
          const matcher = textMatcher(text, { caseSensitive, wholeWord, regex })
          const pdfs = outcome.ok && matcher ? outcome.results.pdfs : []
          setState({ status: 'done', outcome, pdf: pdfs.length > 0 ? 'searching' : null })
          if (!outcome.ok || !matcher || pdfs.length === 0) return
          const pdf = await searchPdfs(outcome.results.root, pdfs, matcher)
          if (alive) setState({ status: 'done', outcome, pdf })
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
  const pdf = state.pdf
  const groups: MatchGroup[] = [
    ...outcome.results.files.map((file) => {
      const full = childPath(root, file.path)
      return {
        path: file.path,
        full,
        lines: file.matches.map((m) => ({
          key: `${m.line}:${m.column}`,
          label: String(m.line),
          text: m.text,
          ranges: m.ranges,
          open: () => openFileAt(full, m.line, m.column),
        })),
      }
    }),
    ...(pdf && pdf !== 'searching' ? pdf.files : []).map((file) => {
      const full = childPath(root, file.path)
      return {
        path: file.path,
        full,
        lines: file.matches.map((m, i) => ({
          key: `${m.page}:${i}`,
          label: fmt(d.filesView.searchPage, { page: String(m.page) }),
          text: m.text,
          ranges: m.ranges,
          open: () => {
            usePdfFindStore.getState().request(full, { page: m.page, query: m.query })
            openFileInWorkspace(full)
          },
        })),
      }
    }),
  ].filter((group) => !isHidden(group.full))
  const matches = groups.reduce((n, g) => n + g.lines.length, 0)
  const notes = (
    <>
      {pdf === 'searching' ? (
        <div className="search-status">{d.filesView.searchingPdfs}</div>
      ) : null}
      {pdf && pdf !== 'searching' && pdf.skipped > 0 ? (
        <div className="search-status">
          {fmt(d.filesView.searchPdfsSkipped, { count: String(pdf.skipped) })}
        </div>
      ) : null}
    </>
  )
  if (names.length === 0 && groups.length === 0) {
    return (
      <>
        {pdf === 'searching' ? null : (
          <div className="search-status">{d.filesView.searchNoResults}</div>
        )}
        {notes}
      </>
    )
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
      {groups.length > 0 ? (
        <section aria-label={d.filesView.searchText}>
          <div className="search-group">
            <span className="search-group-title">{d.filesView.searchText}</span>
            <span>
              {fmt(matches === 1 ? d.filesView.searchSummaryOne : d.filesView.searchSummaryMany, {
                count: String(matches),
                files: String(groups.length),
              })}
            </span>
          </div>
          {groups.map((group) => (
            <MatchGroupRows key={group.path} group={group} />
          ))}
          {outcome.results.truncated ? (
            <div className="search-status">{d.filesView.searchTruncated}</div>
          ) : null}
        </section>
      ) : null}
      {notes}
    </div>
  )
}

interface MatchGroup {
  path: string
  full: string
  lines: {
    key: string
    label: string
    text: string
    ranges: [number, number][]
    open: () => void
  }[]
}

function MatchGroupRows({ group }: { group: MatchGroup }): JSX.Element {
  const entry: FsEntry = { name: group.path.split('/').pop() ?? group.path, dir: false }
  const { Icon, color } = fileIcon(entry, false)
  return (
    <div className="search-file">
      <button
        type="button"
        className="file-row search-row"
        onClick={() => openFileInWorkspace(group.full)}
      >
        <Icon size={16} className="file-icon" style={{ color }} />
        <span className="file-name">{group.path}</span>
      </button>
      {group.lines.map((line) => (
        <button key={line.key} type="button" className="file-row search-line" onClick={line.open}>
          <span className="search-line-number">{line.label}</span>
          <span className="file-name">
            <Highlighted text={line.text} ranges={line.ranges} />
          </span>
        </button>
      ))}
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
  const inputRef = useRef<HTMLInputElement>(null)
  const open = useUIStore((s) => s.filesSearchOpen)
  const focusWanted = useUIStore((s) => s.filesSearchFocus)
  useEffect(() => {
    if (!open) setText('')
  }, [open])
  useEffect(() => {
    if (!focusWanted || !open) return
    const query = useUIStore.getState().filesSearchQuery
    if (query !== null) setText(query)
    inputRef.current?.focus()
    inputRef.current?.select()
    useUIStore.getState().filesSearchFocused()
  }, [focusWanted, open])
  const state = useSearch(root, open ? text : '', toggles)
  const toggle = (key: keyof SearchToggles): void => setToggles((t) => ({ ...t, [key]: !t[key] }))
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    if (text) setText('')
    else useUIStore.getState().hideFilesSearch()
  }
  const reveal = (path: string): void => {
    setText('')
    onReveal(path)
  }
  return (
    <>
      {open ? (
        <div className="files-search">
          <InputGroup className="h-7">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
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
      ) : null}
      {open && text.trim() ? (
        <SearchResults state={state} isHidden={isHidden} onReveal={reveal} />
      ) : (
        children
      )}
    </>
  )
}
