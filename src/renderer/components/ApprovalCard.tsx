import { cn } from '@/lib/utils'
import { ShieldWarningIcon } from '@phosphor-icons/react'
import type { ApprovalKind, ApprovalRequest } from '@shared/approvals'
import type { ReactNode } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { ApprovalActions } from './ApprovalActions'

export function capLabel(caps: Record<string, string>, cap: string): string {
  return caps[cap] ?? cap
}

const KIND_TEXT: Record<Exclude<ApprovalKind, 'capability'>, (d: Dict) => string> = {
  'sandbox-domain': (d) => d.approvals.sandboxDomain,
  'sandbox-port': (d) => d.approvals.sandboxPort,
  secret: (d) => d.approvals.secret,
  package: (d) => d.approvals.package,
  'package-malware': (d) => d.approvals.packageMalware,
  'reach-group': (d) => d.approvals.reachConfirm,
  'reach-project': (d) => d.approvals.reachFolderConfirm,
}

const PLACEMENT_CLASS = {
  pane: 'motion-enter absolute right-2 bottom-2 left-2 z-20 origin-bottom bg-surface-3 shadow-md',
  list: 'dashboard-card bg-surface-1',
} as const

export function ApprovalCard({
  request,
  paneTitle,
  placement = 'pane',
  lead,
}: {
  request: ApprovalRequest
  paneTitle: string
  placement?: keyof typeof PLACEMENT_CLASS
  lead?: ReactNode
}): JSX.Element {
  const d = useDict()
  const kind = request.kind ?? 'capability'
  const subject = request.subject ?? ''
  return (
    <section
      aria-label={d.approvals.title}
      data-approval={request.id}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-line p-3 text-fg text-ui-sm',
        PLACEMENT_CLASS[placement],
      )}
    >
      {lead}
      <div className="flex items-center gap-2">
        <ShieldWarningIcon size={14} aria-hidden />
        <span className="font-medium">{d.approvals.title}</span>
      </div>
      {kind === 'capability' ? (
        <p>
          {fmt(d.approvals.wants, { pane: paneTitle })}{' '}
          {request.caps.map((cap) => capLabel(d.approvals.caps, cap)).join(', ')}
        </p>
      ) : (
        <p className="[overflow-wrap:anywhere]">
          {fmt(KIND_TEXT[kind](d), { pane: paneTitle, subject })}
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{request.action}</span>
        {request.detail ? (
          <code className="line-clamp-3 break-all font-mono text-fg-muted text-ui-xs">
            {request.detail}
          </code>
        ) : null}
      </div>
      <ApprovalActions request={request} size="sm" />
    </section>
  )
}
