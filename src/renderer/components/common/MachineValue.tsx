import { Hint } from '@/components/common/Hint'
import { DASHBOARD_PATH_CHARS } from '@/lib/sidebar/dashboard'
import { shortenPath } from '@/lib/sidebar/railMeta'
import { cn } from '@/lib/utils'

export function MachineValue({ value, label }: { value: string; label?: string }): JSX.Element {
  return (
    <Hint label={value}>
      <span aria-label={label} className="min-w-0 truncate font-mono text-fg-muted text-ui-xs">
        {value}
      </span>
    </Hint>
  )
}

export function PathText({
  path,
  max = DASHBOARD_PATH_CHARS,
  className,
}: { path: string; max?: number; className?: string }): JSX.Element {
  return (
    <Hint label={path}>
      <span className={cn('min-w-0 truncate font-mono text-fg-muted text-ui-xs', className)}>
        {shortenPath(path, max)}
      </span>
    </Hint>
  )
}
