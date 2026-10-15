import { Hint } from '@/components/common/Hint'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { WarningIcon } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { Highlight, SearchScopeProvider, useSearchRow } from './SettingsSearch'

export function WarningNote({
  children,
  actions,
}: {
  children: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <Alert
      className={cn(
        'mt-1 items-center rounded-none border-0 bg-transparent p-0 text-warn-fg has-[.alert-action]:pr-0',
        actions ? 'has-[>svg]:grid-cols-[auto_1fr_auto]' : null,
      )}
    >
      <WarningIcon className="size-3.5" />
      <AlertDescription className="text-warn-fg text-ui-sm [&_p:not(:last-child)]:mb-1">
        {children}
      </AlertDescription>
      {actions ? (
        <AlertAction className="static flex items-center gap-1">{actions}</AlertAction>
      ) : null}
    </Alert>
  )
}

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

export function MachineValue({ value, label }: { value: string; label?: string }): JSX.Element {
  return (
    <Hint label={value}>
      <span aria-label={label} className="min-w-0 truncate font-mono text-fg-muted text-ui-xs">
        {value}
      </span>
    </Hint>
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
  onCommit,
}: {
  label: string
  desc: string
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() && Number.isFinite(n)) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <ControlRow label={label} desc={desc}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="h-7 w-24 font-mono"
      />
    </ControlRow>
  )
}
