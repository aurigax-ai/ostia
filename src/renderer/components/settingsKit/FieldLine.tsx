import type { JSX } from 'react'
import { Highlight, SearchScopeProvider, useSearchLeaf, useSearchRow } from './SettingsSearch'

export function FieldLine({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  const search = useSearchRow([label, desc])
  return (
    <div
      data-settings-row
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className="py-1.5"
    >
      <div className="text-fg text-ui-base">
        <Highlight text={label} />
      </div>
      {desc ? (
        <p className="mt-0.5 text-fg-muted text-ui-sm">
          <Highlight text={desc} />
        </p>
      ) : null}
      <SearchScopeProvider value={search.scope}>
        <div className="mt-1.5 flex flex-wrap items-start gap-3">{children}</div>
      </SearchScopeProvider>
    </div>
  )
}

export function Field({
  label,
  reset,
  children,
}: {
  label: string
  reset?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  useSearchLeaf([label])
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-fg-muted text-ui-xs">
        <Highlight text={label} />
      </span>
      {children}
      <div className="h-4">{reset}</div>
    </div>
  )
}
