export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string
  desc?: string
  action?: React.ReactNode
}): JSX.Element {
  const lead = /[.!?]$/.test(title) ? title : `${title}.`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 text-fg-muted text-ui-sm">
      <p>{desc ? `${lead} ${desc}` : lead}</p>
      {action}
    </div>
  )
}
