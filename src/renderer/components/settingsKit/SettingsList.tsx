import { Children } from 'react'

export function SettingsList({
  label,
  empty,
  add,
  children,
}: {
  label: string
  empty: string
  add?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  const none = Children.toArray(children).length === 0
  return (
    <>
      {none ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{empty}</p>
      ) : (
        <ul aria-label={label} className="flex flex-col">
          {children}
        </ul>
      )}
      {add ? <div className="pt-2">{add}</div> : null}
    </>
  )
}
