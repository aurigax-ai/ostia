import { Children, type JSX } from 'react'

export function SettingsList({
  label,
  labelledBy,
  ordered,
  empty,
  add,
  children,
}: {
  label: string
  labelledBy?: string
  ordered?: boolean
  empty: string
  add?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  const List = ordered ? 'ol' : 'ul'
  const none = Children.toArray(children).length === 0
  return (
    <>
      {none ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{empty}</p>
      ) : (
        <List
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          className="flex flex-col"
        >
          {children}
        </List>
      )}
      {add ? <div className="pt-2">{add}</div> : null}
    </>
  )
}
