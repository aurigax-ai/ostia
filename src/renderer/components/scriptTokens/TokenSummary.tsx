import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type {
  ScriptTokenInfo,
  ScriptTokenScope,
  ScriptTokensState,
} from '@shared/permissions/scriptTokens'
import { Fragment, type JSX, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { shownCaps } from './tokenScope'
import { expiryState } from './tokenText'

export function GroupDot({ color }: { color?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full bg-fg-muted"
      style={color ? { background: `var(--group-${color})` } : undefined}
    />
  )
}

export function ScopeSummary({
  scope,
  state,
}: {
  scope: ScriptTokenScope
  state: ScriptTokensState
}): JSX.Element {
  const d = useDict()
  if (scope.kind === 'all') return <span>{d.scriptTokens.accessAll}</span>
  const parts: ReactNode[] = [
    ...scope.groups.map((id) => {
      const group = state.groups.find((g) => g.id === id)
      return (
        <span key={`g:${id}`} className="inline-flex items-center gap-1">
          <GroupDot color={group?.color} />
          {group?.name ?? d.scriptTokens.deleted}
        </span>
      )
    }),
    ...scope.workspaces.map((id) => {
      const ws = state.workspaces.find((w) => w.id === id)
      return (
        <span key={`w:${id}`}>
          {ws ? fmt(d.scriptTokens.workspaceChip, { name: ws.name }) : d.scriptTokens.deleted}
        </span>
      )
    }),
  ]
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={(part as JSX.Element).key}>
          {i > 0 ? d.scriptTokens.listSep : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}

export function CapsSummary({ caps }: { caps: readonly Capability[] }): JSX.Element {
  const d = useDict()
  const shown = shownCaps(caps)
  if (shown.length > 2)
    return <span>{fmt(d.scriptTokens.permissionCount, { n: shown.length })}</span>
  return (
    <span>{shown.map((cap) => d.scriptTokens.caps[cap].label).join(d.scriptTokens.listSep)}</span>
  )
}

export function Dot(): JSX.Element {
  return (
    <span aria-hidden className="text-fg-dim">
      ·
    </span>
  )
}

export function ExpiryBadge({
  token,
  now,
}: {
  token: ScriptTokenInfo
  now: number
}): JSX.Element | null {
  const d = useDict()
  const state = expiryState(token, now)
  if (state !== 'soon' && state !== 'expired') return null
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-4 rounded-sm px-1 text-ui-xs',
        state === 'soon' ? 'border-warn-fg/40 text-warn-fg' : 'border-attn-fg/40 text-attn-fg',
      )}
    >
      {state === 'soon' ? d.scriptTokens.expiresSoon : d.scriptTokens.expired}
    </Badge>
  )
}

export function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-line px-3 py-2">
      <div className="text-fg-muted text-ui-xs">{label}</div>
      <div className="mt-0.5 text-fg text-ui-sm">{children}</div>
    </div>
  )
}
