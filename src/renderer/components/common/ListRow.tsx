import { CaretDownIcon, CaretRightIcon, type Icon as IconComponent } from '@phosphor-icons/react'
import { type JSX, useId, useState } from 'react'
import { Item, ItemActions, ItemContent } from '@/components/ui/item'
import { cn } from '@/lib/utils'
import { IconButton } from './IconButton'

interface ListRowBase extends Omit<React.ComponentProps<'li'>, 'title' | 'children'> {
  lead?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  detail?: React.ReactNode
  actions?: React.ReactNode | ((toggle: React.ReactNode) => React.ReactNode)
  below?: React.ReactNode
  density?: 'settings' | 'dense'
}

interface Collapsed {
  expanded?: undefined
  expandLabel?: undefined
  expandIcon?: undefined
  defaultOpen?: undefined
}

interface Expandable {
  expanded: React.ReactNode
  expandLabel: string
  expandIcon?: IconComponent
  defaultOpen?: boolean
}

export type ListRowProps = ListRowBase & (Collapsed | Expandable)

export function ListRow({
  lead,
  title,
  meta,
  detail,
  actions,
  below,
  expanded,
  expandLabel,
  expandIcon,
  defaultOpen = false,
  density = 'settings',
  ...props
}: ListRowProps): JSX.Element {
  const dense = density === 'dense'
  const [open, setOpen] = useState(defaultOpen)
  const regionId = useId()
  const toggle = expanded ? (
    <IconButton
      icon={expandIcon ?? (open ? CaretDownIcon : CaretRightIcon)}
      label={expandLabel}
      aria-expanded={open}
      aria-controls={regionId}
      onClick={() => setOpen((was) => !was)}
    />
  ) : null
  return (
    <li {...props}>
      <Item
        size="sm"
        className={cn('items-start gap-2 rounded-none border-0 px-0', dense ? 'py-0' : 'py-1.5')}
      >
        {lead ? (
          <span className={cn('flex shrink-0 items-center text-fg-muted', dense ? 'h-5' : 'h-6')}>
            {lead}
          </span>
        ) : null}
        <ItemContent className="min-w-0 gap-0">
          <div
            className={cn(
              'flex w-full min-w-0 items-center gap-2 text-fg',
              dense ? 'min-h-5 text-ui-sm' : 'min-h-6 text-ui-base',
            )}
          >
            <span className="min-w-0 truncate">{title}</span>
            {meta ? <span className="shrink-0 text-fg-muted text-ui-xs">{meta}</span> : null}
          </div>
          {detail ? <div className="text-fg-muted text-ui-sm">{detail}</div> : null}
        </ItemContent>
        {actions || expanded ? (
          <ItemActions className={cn('shrink-0', dense ? 'min-h-5' : 'min-h-6')}>
            {typeof actions === 'function' ? (
              actions(toggle)
            ) : (
              <>
                {actions}
                {toggle}
              </>
            )}
          </ItemActions>
        ) : null}
      </Item>
      {below}
      {expanded ? (
        <section
          id={regionId}
          aria-label={expandLabel}
          hidden={!open}
          className="mt-1 mb-2 ml-2 pl-4"
        >
          {expanded}
        </section>
      ) : null}
    </li>
  )
}
