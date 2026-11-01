import { InfoIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

const TONES = {
  warn: { icon: WarningIcon, text: 'text-warn-fg' },
  error: { icon: WarningCircleIcon, text: 'text-attn-fg' },
  info: { icon: InfoIcon, text: 'text-fg-muted' },
}

export function Notice({
  tone = 'warn',
  children,
  actions,
  className,
}: {
  tone?: keyof typeof TONES
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
}): JSX.Element {
  const { icon: Icon, text } = TONES[tone]
  return (
    <Alert
      className={cn(
        'mt-1 items-center rounded-none border-0 bg-transparent p-0 has-[.alert-action]:pr-0',
        text,
        actions ? 'has-[>svg]:grid-cols-[auto_1fr_auto]' : null,
        className,
      )}
    >
      <Icon className="size-4" />
      <AlertDescription className={cn('text-ui-sm [&_p:not(:last-child)]:mb-1', text)}>
        {children}
      </AlertDescription>
      {actions ? (
        <AlertAction className="static flex items-center gap-1">{actions}</AlertAction>
      ) : null}
    </Alert>
  )
}
