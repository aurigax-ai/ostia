import type { JSX, ReactNode } from 'react'
import { usePillIdle } from './usePillIdle'

export function FloatPill({
  label,
  held = false,
  activity = 0,
  children,
}: {
  label: string
  held?: boolean
  activity?: number
  children: ReactNode
}): JSX.Element {
  const idle = usePillIdle(held, activity)
  return (
    <div
      ref={idle.ref}
      role="toolbar"
      aria-label={label}
      data-state={idle.state}
      className="absolute top-2 right-2 z-20 flex max-w-[calc(100%-16px)] items-center gap-0.5 rounded-md border border-line-strong bg-surface-2 p-0.5 text-fg-muted opacity-100 shadow-[0_2px_8px_-4px_var(--bg-sunken)] transition-opacity data-[state=idle]:opacity-(--pill-idle-opacity)"
      {...idle.handlers}
    >
      {children}
    </div>
  )
}
