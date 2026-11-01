import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { NumberInput } from './CommitInput'
import { Highlight, SearchScopeProvider, useSearchRow } from './SettingsSearch'

export function ControlRow({
  label,
  desc,
  error,
  errorId,
  labelHint,
  below,
  children,
}: {
  label: string
  desc?: string
  error?: string | null
  errorId?: string
  labelHint?: React.ReactNode
  below?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  const search = useSearchRow([label, desc])
  return (
    <div
      data-settings-row
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className={cn(
        'flex flex-wrap justify-between gap-x-6 gap-y-2 py-1.5',
        desc || error || below ? 'items-start' : 'items-center',
      )}
    >
      <div data-settings-row-text className="min-w-0 grow basis-96">
        {labelHint ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-fg text-ui-base">
              <Highlight text={label} />
            </span>
            {labelHint}
          </div>
        ) : (
          <div className="text-fg text-ui-base">
            <Highlight text={label} />
          </div>
        )}
        {desc ? (
          <p className="mt-0.5 text-fg-muted text-ui-sm">
            <Highlight text={desc} />
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-0.5 text-attn-fg text-ui-sm">
            {error}
          </p>
        ) : null}
        {below ? <div className="mt-1.5">{below}</div> : null}
      </div>
      {children ? (
        <div data-settings-row-control className="flex min-w-0 max-w-full items-center gap-2">
          <SearchScopeProvider value={search.scope}>{children}</SearchScopeProvider>
        </div>
      ) : null}
    </div>
  )
}

export function ExperimentalBadge(): JSX.Element {
  const d = useDict()
  return (
    <Badge variant="outline" className="h-4 px-1 text-ui-xs tracking-caps">
      {d.settings.experimental}
    </Badge>
  )
}

export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  disabled,
  labelHint,
  below,
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  labelHint?: React.ReactNode
  below?: React.ReactNode
}): JSX.Element {
  return (
    <ControlRow label={label} desc={desc} labelHint={labelHint} below={below}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </ControlRow>
  )
}

export function NumberRow({
  label,
  desc,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string
  desc: string
  value: number
  min: number
  max: number
  step?: number
  onCommit: (n: number) => void
}): JSX.Element {
  return (
    <ControlRow label={label} desc={desc}>
      <NumberInput
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onCommit={onCommit}
        className="h-7 w-24 font-mono"
      />
    </ControlRow>
  )
}
