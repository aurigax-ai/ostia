import { useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { GroupStateChips } from '../GroupStatus'
import { RailCardRow } from './RailCardRow'

const HOVER_DELAY_MS = 150
const ROW = '[data-card-row]'

function moveFocus(card: HTMLElement, key: string): void {
  const rows = [...card.querySelectorAll<HTMLElement>(ROW)]
  if (rows.length === 0) return
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? rows.length - 1
        : key === 'ArrowDown'
          ? (at + 1) % rows.length
          : (at - 1 + rows.length) % rows.length
  rows[next]?.focus()
}

export function RailCard({
  title,
  members,
  pressOpens = false,
  className,
  children,
}: {
  title?: string
  members: Workspace[]
  pressOpens?: boolean
  className?: string
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const viaHover = useRef(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next && details.reason === 'trigger-press' && !pressOpens) return
        viaHover.current = details.reason === 'trigger-hover'
        setOpen(next)
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={HOVER_DELAY_MS}
        nativeButton={false}
        role="presentation"
        tabIndex={-1}
        render={<div className={cn('rail-card-trigger', className)} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        initialFocus={() => !viaHover.current}
        className="rail-card w-64 gap-0 p-1"
        onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
          e.preventDefault()
          moveFocus(e.currentTarget, e.key)
        }}
      >
        {title ? (
          <div className="rail-card-head">
            <span className="rail-card-title">{title}</span>
            <GroupStateChips members={members} />
          </div>
        ) : null}
        {members.map((w) => (
          <RailCardRow key={w.id} workspace={w} onPick={() => setOpen(false)} />
        ))}
      </PopoverContent>
    </Popover>
  )
}
