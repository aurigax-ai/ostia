import { CaretRightIcon, CopyIcon } from '@phosphor-icons/react'
import type { GatewayPairRequest } from '@shared/gateway/gatewayApi'
import { formatCode } from '@shared/gateway/pairCode'
import { PHONE_GRANTABLE_CAPS } from '@shared/gateway/phoneCapabilities'
import { type JSX, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { formatDate } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { capText } from './GatewayDevices'
import type { PairCode } from './usePairCode'

function spacedCheckCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function ReplacesNote({
  replaces,
}: {
  replaces: NonNullable<GatewayPairRequest['replaces']>
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const text = capText(d)
  const kept = PHONE_GRANTABLE_CAPS.filter((cap) => replaces.caps.includes(cap)).map(
    (cap) => text[cap].label,
  )
  const when = replaces.lastSeenAt
    ? formatDate(Date.parse(replaces.lastSeenAt), locale)
    : d.settings.remotePairNeverSeen
  return (
    <>
      <p className="mt-0.5 text-fg-muted text-ui-sm">
        {fmt(d.settings.remotePairReplaces, { name: replaces.name, when })}
      </p>
      <p className="mt-0.5 text-fg-muted text-ui-sm">
        {kept.length > 0
          ? fmt(d.settings.remotePairKeeps, { caps: kept.join(', ') })
          : d.settings.remotePairKeepsNone}
      </p>
    </>
  )
}

export function PairRequests({
  requests,
  onAnswer,
}: {
  requests: GatewayPairRequest[]
  onAnswer: (requestId: string, approve: boolean) => void
}): JSX.Element | null {
  const d = useDict()
  if (requests.length === 0) return null
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {requests.map((r) => (
        <li
          key={r.requestId}
          className="motion-enter flex items-center justify-between gap-4 rounded-md border border-line-strong bg-surface-1 p-3"
        >
          <div className="min-w-0">
            <div className="truncate text-fg text-ui-base">
              {fmt(d.settings.remotePairRequest, { name: r.name })}
            </div>
            <div className="mt-1 font-mono font-semibold text-fg text-ui-lg tabular-nums">
              {spacedCheckCode(r.checkCode)}
            </div>
            <p className="mt-0.5 text-fg-muted text-ui-sm">
              {fmt(d.settings.remotePairCheck, { code: spacedCheckCode(r.checkCode) })}
            </p>
            {r.replaces ? <ReplacesNote replaces={r.replaces} /> : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAnswer(r.requestId, false)}
              aria-label={fmt(d.settings.remotePairDenyFor, { name: r.name })}
            >
              {d.settings.remotePairDeny}
            </Button>
            <Button
              size="sm"
              onClick={() => onAnswer(r.requestId, true)}
              aria-label={fmt(d.settings.remotePairApproveFor, { name: r.name })}
            >
              {d.settings.remotePairApprove}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function PairCodePanel({ pair }: { pair: PairCode }): JSX.Element | null {
  const d = useDict()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const { pairResult, qrDataUrl, secondsLeft, copied, onCopy } = pair
  return pairResult && qrDataUrl ? (
    <div className="mt-3 rounded-md border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-6">
        <img
          src={qrDataUrl}
          alt={d.settings.remotePair}
          width={180}
          height={180}
          className="shrink-0 rounded-md bg-white p-2"
        />
        <dl className="flex min-w-0 flex-col gap-3">
          <div>
            <dt className="text-fg-muted text-ui-xs">{d.settings.remotePairCode}</dt>
            <dd className="select-all font-mono font-semibold text-fg text-ui-lg">
              {formatCode(pairResult.pairCode)}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted text-ui-xs">{d.settings.remotePairAddress}</dt>
            <dd className="font-mono text-fg text-ui-sm">
              {pairResult.host}:{pairResult.port}
            </dd>
          </div>
          <p className="text-fg-muted text-ui-xs">
            {fmt(d.settings.remotePairExpires, { n: Math.max(secondsLeft, 0) })}
          </p>
        </dl>
      </div>
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-3">
        <div className="flex items-center justify-between">
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="xs" className="-ml-2 text-fg-muted hover:text-fg">
                <CaretRightIcon
                  className={cn('transition-transform', detailsOpen && 'rotate-90')}
                />
                {d.settings.remotePairDetails}
              </Button>
            }
          />
          <Button variant="ghost" size="xs" onClick={() => void onCopy()}>
            <CopyIcon data-icon="inline-start" />
            {copied ? d.settings.remoteCopied : d.settings.remoteCopy}
          </Button>
        </div>
        <CollapsibleContent>
          <Textarea
            readOnly
            value={JSON.stringify(pairResult, null, 2)}
            rows={8}
            aria-label={d.settings.remotePairDetails}
            className="field-sizing-fixed mt-1 resize-none font-mono text-fg-muted"
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  ) : null
}
