import type { JSX } from 'react'
import { cn } from '@/lib/utils'

const VARIANTS = {
  unread:
    'inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-attn px-1 font-medium text-on-attn',
  attn: 'text-attn-fg',
}

export function CountBadge({
  count,
  variant,
  label,
}: {
  count: number
  variant: keyof typeof VARIANTS
  label?: string
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the block for screen readers and tests; a role would change how it is announced
    <span
      className={cn('shrink-0 text-ui-xs tabular-nums', VARIANTS[variant])}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {count}
    </span>
  )
}
