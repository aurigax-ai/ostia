import type { JSX } from 'react'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

const SECONDARY_CLASS = 'min-w-0 truncate text-fg-muted text-ui-xs'

export function ItemRow({
  name,
  meta,
  keys,
  detail,
  mono,
  nameMono,
  after,
}: {
  name: string
  meta?: React.ReactNode
  keys?: string | null
  detail?: string
  mono?: boolean
  nameMono?: boolean
  after?: React.ReactNode
}): JSX.Element {
  return (
    <span data-slot="palette-row" className="flex min-w-0 flex-1 items-center gap-x-3 tabular-nums">
      <span data-slot="palette-title" className="flex min-w-0 items-center">
        <span data-slot="palette-name" className={cn('min-w-0 truncate', nameMono && 'font-mono')}>
          {name}
        </span>
        {after ? <span className="ml-2 flex shrink-0 items-center gap-1.5">{after}</span> : null}
      </span>
      {detail ? (
        <span data-slot="palette-detail" className={SECONDARY_CLASS}>
          {detail}
        </span>
      ) : null}
      {keys || meta ? (
        <span
          data-slot="palette-trailing"
          className="ml-auto flex max-w-[60%] shrink-0 items-center gap-x-3"
        >
          {keys ? (
            <Kbd data-slot="palette-keys" className="shrink-0 whitespace-nowrap">
              {keys}
            </Kbd>
          ) : null}
          {meta ? (
            <span
              data-slot="palette-meta"
              className={cn(
                SECONDARY_CLASS,
                'group-data-selected/command-item:text-fg',
                mono && 'font-mono',
              )}
            >
              {meta}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}
