import { Item, ItemActions, ItemContent } from '@/components/ui/item'
import { cn } from '@/lib/utils'

export interface ListRowProps extends Omit<React.ComponentProps<'li'>, 'title' | 'children'> {
  lead?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  detail?: React.ReactNode
  actions?: React.ReactNode
  expanded?: React.ReactNode
  density?: 'settings' | 'dense'
}

export function ListRow({
  lead,
  title,
  meta,
  detail,
  actions,
  expanded,
  density = 'settings',
  ...props
}: ListRowProps): JSX.Element {
  const dense = density === 'dense'
  return (
    <li {...props}>
      <Item
        size="sm"
        className={cn('items-start gap-2 rounded-none border-0 px-0', dense ? 'py-0.5' : 'py-1.5')}
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
        {actions ? (
          <ItemActions className={cn('shrink-0', dense ? 'min-h-5' : 'min-h-6')}>
            {actions}
          </ItemActions>
        ) : null}
      </Item>
      {expanded ? <div className="mt-1 mb-2 ml-2 border-line border-l pl-4">{expanded}</div> : null}
    </li>
  )
}
