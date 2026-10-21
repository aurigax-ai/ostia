import type { AttentionState } from '@shared/attention/attention'

export function StateLabel({
  state,
  label,
}: {
  state: AttentionState | 'idle'
  label: string
}): JSX.Element | null {
  if (state === 'idle' || state === 'none') return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-fg-muted text-ui-xs">
      <span className={`dot ${state}`} aria-hidden="true" />
      {label}
    </span>
  )
}
