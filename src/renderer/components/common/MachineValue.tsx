import type { JSX } from 'react'
import { Hint } from '@/components/common/Hint'
import { WHERE_PATH_CHARS } from '@/lib/agents/needsYou'
import { shortenPath } from '@/lib/sidebar/railMeta'
import { cn } from '@/lib/utils'

export function MachineValue({ value, label }: { value: string; label?: string }): JSX.Element {
  const text = (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the value for screen readers and tests; a role would change how it is announced
    <span aria-label={label} className="min-w-0 truncate font-mono text-fg-muted text-ui-xs">
      {value}
    </span>
  )
  return <Hint label={value}>{text}</Hint>
}

export function PathText({
  path,
  max = WHERE_PATH_CHARS,
  className,
}: {
  path: string
  max?: number
  className?: string
}): JSX.Element {
  return (
    <Hint label={path}>
      <span className={cn('min-w-0 truncate font-mono text-fg-muted text-ui-xs', className)}>
        {shortenPath(path, max)}
      </span>
    </Hint>
  )
}
