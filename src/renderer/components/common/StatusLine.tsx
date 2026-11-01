import { InfoIcon, WarningCircleIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import { type JSX, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'

const TONES = {
  muted: { icon: InfoIcon, color: 'text-fg-muted' },
  warn: { icon: WarningIcon, color: 'text-warn-fg' },
  error: { icon: WarningCircleIcon, color: 'text-attn-fg' },
} as const

export type StatusTone = keyof typeof TONES

export function StatusLine({
  tone = 'muted',
  children,
  actions,
  onDismiss,
  dismissDisabled,
  wrap,
  className,
  ...rest
}: Omit<React.ComponentProps<'output'>, 'children'> & {
  tone?: StatusTone
  children: React.ReactNode
  actions?: React.ReactNode
  onDismiss?: () => void
  dismissDisabled?: boolean
  wrap?: boolean
}): JSX.Element {
  const d = useDict()
  const { icon: Icon, color } = TONES[tone]
  return (
    <output
      className={cn(
        'motion-enter-edge flex w-full shrink-0 items-center gap-2 bg-surface-1 px-3 text-fg text-ui-sm',
        wrap ? 'min-h-8 py-1' : 'h-8',
        className,
      )}
      {...rest}
    >
      <Icon size={16} aria-hidden className={cn('shrink-0', color)} />
      <span className={cn('min-w-0 flex-1', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>
        {children}
      </span>
      {actions}
      {onDismiss ? (
        <IconButton
          icon={XIcon}
          label={d.pane.dismissStatus}
          disabled={dismissDisabled}
          onClick={onDismiss}
        />
      ) : null}
    </output>
  )
}

export function StatusAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'>): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="xs"
      className={cn('shrink-0 text-fg-muted hover:text-fg', className)}
      {...props}
    />
  )
}

export function useDismissed(key: string): [boolean, () => void] {
  const [gone, setGone] = useState<string | null>(null)
  return [gone === key, () => setGone(key)]
}
