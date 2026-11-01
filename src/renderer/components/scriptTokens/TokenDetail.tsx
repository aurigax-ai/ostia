import { CaretLeftIcon, KeyIcon, PlusIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import {
  SCRIPT_TOKEN_RUN_CAPS,
  type ScriptTokenCall,
  type ScriptTokenInfo,
  type ScriptTokensState,
  type ScriptTokenUsage,
} from '@shared/permissions/scriptTokens'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { ExpiryBadge, GroupDot, Stat } from './TokenSummary'
import { groupSize, shownCaps } from './tokenScope'
import { daysUntil, expiryState, lastUsedText, localDate, localTime } from './tokenText'

function callTime(iso: string, now: number): string {
  return localDate(iso) === localDate(new Date(now).toISOString())
    ? localTime(iso)
    : `${localDate(iso)} ${localTime(iso)}`
}

function callTarget(d: Dict, call: ScriptTokenCall, names: ScriptTokenUsage['names']): string {
  const { workspaceId, paneId } = call.target
  if (!workspaceId && !paneId) return '—'
  const workspace = workspaceId ? (names.workspaces[workspaceId] ?? d.scriptTokens.deleted) : null
  if (!paneId) return workspace ?? '—'
  const pane = names.panes[paneId] ?? d.scriptTokens.deleted
  return workspace ? `${workspace} / ${pane}` : pane
}

const RESULT_STYLE: Record<ScriptTokenCall['outcome'], string> = {
  ok: 'border-ok/40 text-ok',
  'out-of-scope': 'border-attn-fg/40 text-attn-fg',
  'missing-permission': 'border-warn-fg/40 text-warn-fg',
  error: 'border-line text-fg-muted',
  regenerated: 'border-line text-fg-muted',
}

function resultText(d: Dict, outcome: ScriptTokenCall['outcome']): string {
  const t = d.scriptTokens
  if (outcome === 'ok') return t.resultOk
  if (outcome === 'out-of-scope') return t.resultOutOfScope
  if (outcome === 'missing-permission') return t.resultMissing
  if (outcome === 'regenerated') return t.regenerated
  return t.resultError
}

function CallLog({ usage, now }: { usage: ScriptTokenUsage | null; now: number }): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const calls = usage?.calls ?? []
  return (
    <div className="min-w-0 rounded-md border border-line px-3 py-2.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-medium text-fg text-ui-sm">{t.recentCalls}</h3>
        <span className="text-fg-dim text-ui-xs">{t.recentCallsNote}</span>
      </div>
      {calls.length === 0 ? (
        <p className="py-2 text-fg-muted text-ui-sm">{t.noCalls}</p>
      ) : (
        <table className="w-full table-fixed text-ui-sm">
          <thead className="text-left text-fg-dim text-ui-xs">
            <tr>
              <th className="w-[22%] pb-1 font-normal">{t.colTime}</th>
              <th className="w-[30%] pb-1 font-normal">{t.colAction}</th>
              <th className="pb-1 font-normal">{t.colTarget}</th>
              <th className="w-[22%] pb-1 text-right font-normal">{t.colResult}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the index tells repeated entries apart and the list is rebuilt, never reordered
              <tr key={`${call.at}:${i}`} className="border-line border-t">
                <td className="py-1.5 font-mono text-fg-dim">{callTime(call.at, now)}</td>
                <td className="truncate py-1.5 font-mono text-fg">
                  {call.outcome === 'regenerated' ? t.regenerated : call.method}
                </td>
                <td className="truncate py-1.5 text-fg-muted">
                  {usage ? callTarget(d, call, usage.names) : '—'}
                </td>
                <td className="py-1.5 text-right">
                  {call.outcome === 'regenerated' ? null : (
                    <Badge
                      variant="outline"
                      title={call.code}
                      className={cn('h-4 rounded-sm px-1 text-ui-xs', RESULT_STYLE[call.outcome])}
                    >
                      {resultText(d, call.outcome)}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function connectionText(d: Dict, usage: ScriptTokenUsage | null): string | null {
  const pids = (usage?.connections ?? []).flatMap((c) => c.pid ?? [])
  return pids.length > 0 ? fmt(d.scriptTokens.connectionPid, { pid: pids.join(', ') }) : null
}

export function TokenDetail({
  token,
  state,
  usage,
  now,
  locale,
  onBack,
  onEdit,
  onRevoke,
}: {
  token: ScriptTokenInfo
  state: ScriptTokensState
  usage: ScriptTokenUsage | null
  now: number
  locale: string
  onBack: () => void
  onEdit: () => void
  onRevoke: () => void
}): JSX.Element {
  const d = useDict()
  const t = d.scriptTokens
  const caps = shownCaps(token.caps)
  const created = fmt(token.source === 'settings' ? t.createdInSettings : t.createdFromCli, {
    date: localDate(token.createdAt),
  })
  const expiry = expiryState(token, now)
  const source = connectionText(d, usage)
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1 text-fg-muted text-ui-sm hover:text-fg"
      >
        <CaretLeftIcon className="size-4" />
        {t.back}
      </button>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <KeyIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-fg text-ui-lg">{token.name}</h2>
            <ExpiryBadge token={token} now={now} />
          </div>
          <p className="text-fg-muted text-ui-sm">{created}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          {t.edit}
        </Button>
        <Button variant="destructive" size="sm" onClick={onRevoke}>
          {t.revoke}
        </Button>
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        <Stat label={t.detailExpires}>
          <div>{token.expiresAt ? localDate(token.expiresAt) : t.neverExpires}</div>
          {token.expiresAt && expiry !== 'expired' ? (
            <div className="text-fg-muted text-ui-xs">
              {fmt(t.daysLeft, { n: daysUntil(token.expiresAt, now) })}
            </div>
          ) : null}
          {expiry === 'expired' ? <div className="text-attn-fg text-ui-xs">{t.expired}</div> : null}
        </Stat>
        <Stat label={t.lastUsed}>
          <div>{lastUsedText(d, token.lastUsedAt, now, locale)}</div>
          {token.lastUsedAt ? (
            <div className="text-fg-muted text-ui-xs">{localTime(token.lastUsedAt)}</div>
          ) : null}
        </Stat>
        <Stat label={t.detailConnections}>
          <div>{fmt(t.connectionCount, { n: usage?.connections.length ?? 0 })}</div>
          {source ? <div className="truncate text-fg-muted text-ui-xs">{source}</div> : null}
        </Stat>
        <Stat label={t.detailCalls24h}>
          <div>{fmt(t.callCount, { n: usage?.last24h.calls ?? 0 })}</div>
          <div className="text-fg-muted text-ui-xs">
            {fmt(t.refusedCount, { n: usage?.last24h.refused ?? 0 })}
          </div>
        </Stat>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-2">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="rounded-md border border-line px-3 py-2.5">
            <h3 className="mb-2 font-medium text-fg text-ui-sm">{t.access}</h3>
            {token.scope.kind === 'all' ? (
              <p className="text-fg text-ui-sm">{t.accessAll}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-fg text-ui-sm">
                {token.scope.groups.map((id) => {
                  const group = state.groups.find((g) => g.id === id)
                  return (
                    <li key={`g:${id}`} className="flex items-center gap-1.5">
                      <GroupDot color={group?.color} />
                      {group ? fmt(t.groupChip, { name: group.name }) : t.deleted}
                      {group ? <span className="text-fg-dim">· {groupSize(id, state)}</span> : null}
                    </li>
                  )
                })}
                {token.scope.workspaces.map((id) => {
                  const ws = state.workspaces.find((w) => w.id === id)
                  return (
                    <li key={`w:${id}`}>
                      {ws ? fmt(t.workspaceChip, { name: ws.name }) : t.deleted}
                    </li>
                  )
                })}
                {token.scope.ownWorkspaces ? (
                  <li className="flex items-center gap-1.5 text-fg-muted">
                    <PlusIcon className="size-4" />
                    {t.accessOwnShort}
                  </li>
                ) : null}
              </ul>
            )}
          </div>
          <div className="rounded-md border border-line px-3 py-2.5">
            <h3 className="mb-2 font-medium text-fg text-ui-sm">{t.permissions}</h3>
            <ul className="flex flex-col gap-1 text-fg text-ui-sm">
              {caps.map((cap) => (
                <li key={cap} className="flex items-center justify-between gap-2">
                  {t.caps[cap].label}
                  {SCRIPT_TOKEN_RUN_CAPS.includes(cap) ? (
                    <span className="text-warn-fg text-ui-xs">{t.canRunCommands}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <CallLog usage={usage} now={now} />
      </div>
    </div>
  )
}
