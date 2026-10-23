import { Highlight, SearchScopeProvider, useSearchGroup, useSearchLeaf } from './SettingsSearch'

export function SettingsGroup({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc?: string
  action?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  const search = useSearchGroup([title, desc])
  return (
    <section hidden={search.hidden} className="mt-7 first-of-type:mt-3">
      <div className="mb-2 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="font-semibold text-fg text-ui-emphasis">
            <Highlight text={title} />
          </h3>
          {desc ? (
            <p className="mt-0.5 text-fg-muted text-ui-sm">
              <Highlight text={desc} />
            </p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <SearchScopeProvider value={search.scope}>{children}</SearchScopeProvider>
    </section>
  )
}

export function SettingsSubgroup({ title, desc }: { title: string; desc?: string }): JSX.Element {
  useSearchLeaf([title, desc])
  return (
    <div className="mb-2">
      <h3 className="font-medium text-fg text-ui-base">
        <Highlight text={title} />
      </h3>
      {desc ? (
        <p className="mt-0.5 text-fg-muted text-ui-sm">
          <Highlight text={desc} />
        </p>
      ) : null}
    </div>
  )
}
