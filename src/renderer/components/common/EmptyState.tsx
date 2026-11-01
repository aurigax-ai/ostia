import type { JSX } from 'react'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { cn } from '@/lib/utils'

interface BlockProps {
  variant: 'block'
  title: string
  desc?: string
  action?: React.ReactNode
}

interface SurfaceProps {
  variant: 'surface'
  size?: 'lg' | 'sm'
  icon?: React.ReactNode
  title?: React.ReactNode
  titleAs?: 'h1' | 'h2'
  titleClassName?: string
  desc?: React.ReactNode | React.ReactNode[]
  descClassName?: string
  headerClassName?: string
  actions?: React.ReactNode
  actionsClassName?: string
  className?: string
  role?: 'alert' | 'status'
  'data-testid'?: string
  children?: React.ReactNode
}

const SIZES = {
  lg: { title: 'font-semibold text-fg text-ui-lg', desc: 'text-ui-base' },
  sm: { title: 'font-semibold text-fg text-ui-base', desc: 'text-ui-sm' },
}

function Block({ title, desc, action }: Omit<BlockProps, 'variant'>): JSX.Element {
  const lead = /[.!?。！？]$/.test(title) ? title : `${title}.`
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 text-fg-muted text-ui-sm">
      <p>{desc ? `${lead} ${desc}` : lead}</p>
      {action}
    </div>
  )
}

function Surface({
  size = 'lg',
  icon,
  title,
  titleAs,
  titleClassName,
  desc,
  descClassName,
  headerClassName,
  actions,
  actionsClassName,
  className,
  role,
  'data-testid': testId,
  children,
}: Omit<SurfaceProps, 'variant'>): JSX.Element {
  const classes = SIZES[size]
  const lines = Array.isArray(desc) ? desc : desc ? [desc] : []
  const hasHeader = icon || title || lines.length > 0
  const heading = titleAs === 'h1' ? <h1>{title}</h1> : titleAs === 'h2' ? <h2>{title}</h2> : title
  return (
    <Empty className={className} role={role} data-testid={testId}>
      {hasHeader ? (
        <EmptyHeader className={headerClassName}>
          {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
          {title ? (
            <EmptyTitle className={cn(classes.title, titleClassName)}>{heading}</EmptyTitle>
          ) : null}
          {lines.map((line, index) => (
            <EmptyDescription
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines never reorder
              key={index}
              className={cn(classes.desc, descClassName)}
            >
              {line}
            </EmptyDescription>
          ))}
        </EmptyHeader>
      ) : null}
      {actions ? <EmptyContent className={actionsClassName}>{actions}</EmptyContent> : null}
      {children}
    </Empty>
  )
}

export function EmptyState(props: BlockProps | SurfaceProps): JSX.Element {
  if (props.variant === 'block') return <Block {...props} />
  return <Surface {...props} />
}
