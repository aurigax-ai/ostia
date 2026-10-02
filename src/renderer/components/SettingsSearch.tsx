import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { highlightParts, matchesQuery } from '../lib/settingsSearch'

interface SearchScope {
  query: string
  forced: boolean
  register: () => () => void
}

type SearchTexts = readonly (string | null | undefined)[]

const SettingsSearchContext = createContext<SearchScope | null>(null)

export function useSettingsSearch(): SearchScope | null {
  return useContext(SettingsSearchContext)
}

function useHitCounter(forwardTo?: () => () => void): [number, () => () => void] {
  const [hits, setHits] = useState(0)
  const register = useCallback(() => {
    setHits((n) => n + 1)
    const releaseParent = forwardTo?.()
    return () => {
      setHits((n) => n - 1)
      releaseParent?.()
    }
  }, [forwardTo])
  return [hits, register]
}

function useReportHit(search: SearchScope | null, hit: boolean): void {
  const register = search?.register
  useLayoutEffect(() => {
    if (!hit || !register) return
    return register()
  }, [hit, register])
}

function useScopeValue(
  search: SearchScope | null,
  forced: boolean,
  register: () => () => void,
): SearchScope | null {
  const query = search?.query
  return useMemo(
    () => (query === undefined ? null : { query, forced, register }),
    [query, forced, register],
  )
}

export function useSearchLeaf(texts: SearchTexts): boolean {
  const search = useSettingsSearch()
  const hit = search !== null && matchesQuery(texts, search.query)
  useReportHit(search, hit)
  return hit
}

export function useSearchRow(texts: SearchTexts): {
  hidden: boolean
  hit: boolean
  scope: SearchScope | null
} {
  const search = useSettingsSearch()
  const [childHits, register] = useHitCounter()
  const hit = search !== null && (matchesQuery(texts, search.query) || childHits > 0)
  useReportHit(search, hit)
  const scope = useScopeValue(search, search?.forced ?? false, register)
  return { hidden: search !== null && !hit && !search.forced, hit, scope }
}

export function useSearchGroup(texts: SearchTexts): {
  hidden: boolean
  hit: boolean
  scope: SearchScope | null
} {
  const search = useSettingsSearch()
  const [hits, register] = useHitCounter(search?.register)
  const hit = search !== null && matchesQuery(texts, search.query)
  useReportHit(search, hit)
  const forced = search !== null && (search.forced || hit)
  const scope = useScopeValue(search, forced, register)
  return { hidden: search !== null && !forced && hits === 0, hit, scope }
}

export function SearchScopeProvider({
  value,
  children,
}: {
  value: SearchScope | null
  children: ReactNode
}): JSX.Element {
  return <SettingsSearchContext.Provider value={value}>{children}</SettingsSearchContext.Provider>
}

export function SearchGroup({
  texts,
  children,
}: {
  texts: SearchTexts
  children: (state: { hidden: boolean; hit: boolean }) => ReactNode
}): JSX.Element {
  const { hidden, hit, scope } = useSearchGroup(texts)
  return <SearchScopeProvider value={scope}>{children({ hidden, hit })}</SearchScopeProvider>
}

export function Highlight({ text }: { text: string }): JSX.Element {
  const search = useSettingsSearch()
  if (!search) return <>{text}</>
  return (
    <>
      {highlightParts(text, search.query).map((part) =>
        part.match ? (
          <mark key={part.at} className="settings-search-mark">
            {part.text}
          </mark>
        ) : (
          <span key={part.at}>{part.text}</span>
        ),
      )}
    </>
  )
}

export function SettingsSearchSection({
  id,
  label,
  query,
  onHits,
  children,
}: {
  id: string
  label: string
  query: string
  onHits: (id: string, hits: number) => void
  children: ReactNode
}): JSX.Element {
  const [hits, register] = useHitCounter()
  const forced = matchesQuery([label], query)
  const scope = useMemo(() => ({ query, forced, register }), [query, forced, register])
  const report = useRef(onHits)
  report.current = onHits
  useLayoutEffect(() => {
    report.current(id, hits)
  }, [id, hits])
  return (
    <section data-settings-result={id} hidden={!forced && hits === 0} className="pb-8">
      <SearchScopeProvider value={scope}>{children}</SearchScopeProvider>
    </section>
  )
}
