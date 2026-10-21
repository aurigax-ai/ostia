import { Hint } from '@/components/common/Hint'
import { DASHBOARD_PATH_CHARS } from '@/lib/sidebar/dashboard'
import { shortenPath } from '@/lib/sidebar/railMeta'

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
}: { path: string; max?: number }): JSX.Element {
  return (
    <Hint label={path}>
      <span className="min-w-0 truncate font-mono text-fg-muted text-ui-xs">
        {shortenPath(path, max)}
      </span>
    </Hint>
  )
}
