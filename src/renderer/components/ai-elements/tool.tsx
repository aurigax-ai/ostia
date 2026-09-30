import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import {
  CaretDownIcon,
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  type Icon,
  ProhibitIcon,
  SpinnerGapIcon,
  WrenchIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import type { ComponentProps, ReactNode } from 'react'

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolState = ToolPart['state']

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      'group/tool not-typeset w-full rounded-md border border-line bg-surface-1',
      className,
    )}
    {...props}
  />
)

const STATE_ICONS: Record<ToolState, Icon> = {
  'input-streaming': CircleIcon,
  'input-available': SpinnerGapIcon,
  'approval-requested': ClockIcon,
  'approval-responded': ClockIcon,
  'output-available': CheckCircleIcon,
  'output-error': XCircleIcon,
  'output-denied': ProhibitIcon,
}

const STATE_TONES: Record<ToolState, string> = {
  'input-streaming': 'text-fg-muted',
  'input-available': 'text-fg-muted',
  'approval-requested': 'text-fg',
  'approval-responded': 'text-fg-muted',
  'output-available': 'text-ok',
  'output-error': 'text-attn-fg',
  'output-denied': 'text-fg-muted',
}

export type ToolStatusProps = ComponentProps<'span'> & { state: ToolState; label: string }

export const ToolStatus = ({ state, label, className, ...props }: ToolStatusProps) => {
  const StateIcon = STATE_ICONS[state]
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-ui-xs', STATE_TONES[state], className)}
      data-state={state}
      {...props}
    >
      <StateIcon className="size-3.5" />
      {label}
    </span>
  )
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: ReactNode
  state: ToolState
  stateLabel: string
}

export const ToolHeader = ({ className, title, state, stateLabel, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2/60',
      className,
    )}
    {...props}
  >
    <WrenchIcon className="size-3.5 shrink-0 text-fg-muted" />
    <span className="min-w-0 flex-1 truncate font-mono text-fg text-ui-sm">{title}</span>
    <ToolStatus state={state} label={stateLabel} />
    <CaretDownIcon className="size-3 shrink-0 text-fg-muted transition-transform group-data-[open]/tool:rotate-180" />
  </CollapsibleTrigger>
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn('flex flex-col gap-2 border-line border-t px-2 py-2', className)}
    {...props}
  />
)

export type ToolSectionProps = ComponentProps<'div'> & {
  label: string
  code: string
  tone?: 'default' | 'error'
}

export const ToolSection = ({
  label,
  code,
  tone = 'default',
  className,
  ...props
}: ToolSectionProps) => (
  <div className={cn('flex min-w-0 flex-col gap-1', className)} {...props}>
    <span className="text-fg-muted text-ui-xs">{label}</span>
    <pre
      className={cn(
        'max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-bg-sunken p-2 font-mono text-ui-xs',
        tone === 'error' ? 'text-attn-fg' : 'text-fg',
      )}
    >
      {code}
    </pre>
  </div>
)
