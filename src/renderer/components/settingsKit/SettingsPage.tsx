import { type JSX, useId } from 'react'
import { Highlight, useSearchLeaf } from './SettingsSearch'

export function SettingsPage({
  title,
  desc,
  actions,
  children,
}: {
  title: string
  desc?: string
  actions?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  useSearchLeaf([title, desc])
  const headingId = useId()
  const head = (
    <>
      <h2 id={headingId} className="mb-1.5 font-semibold text-fg text-ui-lg">
        <Highlight text={title} />
      </h2>
      {desc ? (
        <p className="mb-3 text-fg-muted text-ui-sm">
          <Highlight text={desc} />
        </p>
      ) : null}
    </>
  )
  return (
    <section aria-labelledby={headingId}>
      {actions ? (
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">{head}</div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      ) : (
        head
      )}
      {children}
    </section>
  )
}
