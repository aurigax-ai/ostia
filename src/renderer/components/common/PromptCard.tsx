import { type Icon as IconComponent, XIcon } from '@phosphor-icons/react'
import { IconButton } from '@/components/common/IconButton'
import { cn } from '@/lib/utils'

const TONES = {
  muted: 'text-fg-muted',
  warn: 'text-warn-fg',
  error: 'text-attn-fg',
} as const

export type PromptTone = keyof typeof TONES

export function PromptCard({
  icon: Icon,
  tone = 'muted',
  label,
  title,
  children,
  actions,
  dismissLabel,
  onDismiss,
  ...rest
}: Omit<React.ComponentProps<'section'>, 'title' | 'children'> & {
  icon: IconComponent
  tone?: PromptTone
  label: string
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  dismissLabel: string
  onDismiss: () => void
}): JSX.Element {
  return (
    <section
      aria-label={label}
      className="motion-enter absolute right-3 bottom-3 z-20 flex w-[calc(100%-1.5rem)] max-h-[calc(100%-1.5rem)] max-w-[560px] origin-bottom-right flex-col overflow-y-auto gap-2 rounded-lg bg-surface-3 p-3 text-fg text-ui-sm shadow-md ring-1 ring-foreground/10"
      {...rest}
    >
      <div className="flex items-start gap-2">
        <Icon size={16} aria-hidden className={cn('mt-0.5 shrink-0', TONES[tone])} />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <div className="font-medium text-fg">{title}</div>
          {children ? <div className="text-fg-muted">{children}</div> : null}
        </div>
        <IconButton
          icon={XIcon}
          label={dismissLabel}
          className="-mt-0.5 -mr-1"
          onClick={onDismiss}
        />
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </section>
  )
}
