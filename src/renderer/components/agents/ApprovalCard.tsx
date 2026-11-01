import { ShieldWarningIcon } from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import type { ApprovalKind, ApprovalRequest } from '@shared/permissions/approvals'
import type { JSX, ReactNode } from 'react'
import { PromptCard, type PromptTone } from '@/components/common/PromptCard'
import { fmt, useDict } from '@/lib/app/useDict'
import { approvalPromptKey, useHiddenPromptsStore } from '@/stores/agents/hiddenPromptsStore'
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
  'account-switch': (d) => d.approvals.accountSwitch,
  'reach-group': (d) => d.approvals.reachConfirm,
  'reach-project': (d) => d.approvals.reachFolderConfirm,
}

function requestText(d: Dict, request: ApprovalRequest, paneTitle: string): string {
  const kind = request.kind ?? 'capability'
  if (kind === 'capability') {
    const caps = request.caps.map((cap) => capLabel(d.approvals.caps, cap)).join(', ')
    return `${fmt(d.approvals.wants, { pane: paneTitle })} ${caps}`
  }
  return fmt(KIND_TEXT[kind](d), { pane: paneTitle, subject: request.subject ?? '' })
}

function requestTone(kind: ApprovalKind | undefined): PromptTone {
  if (kind === 'package-malware') return 'error'
  return kind && kind !== 'capability' ? 'warn' : 'muted'
}

function RequestDetail({ request }: { request: ApprovalRequest }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium">{request.action}</span>
      {request.detail ? (
        <code className="line-clamp-3 break-all font-mono text-fg-muted text-ui-xs">
          {request.detail}
        </code>
      ) : null}
    </div>
  )
}

export function ApprovalCard({
  request,
  paneTitle,
  lead,
}: {
  request: ApprovalRequest
  paneTitle: string
  lead?: ReactNode
}): JSX.Element {
  const d = useDict()
  return (
    <section
      aria-label={d.approvals.title}
      data-approval={request.id}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-1 p-3 text-fg text-ui-sm"
    >
      {lead}
      <div className="flex items-center gap-2">
        <ShieldWarningIcon size={16} aria-hidden />
        <span className="font-medium">{d.approvals.title}</span>
      </div>
      <p className="[overflow-wrap:anywhere]">{requestText(d, request, paneTitle)}</p>
      <RequestDetail request={request} />
      <ApprovalActions request={request} size="sm" />
    </section>
  )
}

export function ApprovalPrompt({
  request,
  paneTitle,
}: {
  request: ApprovalRequest
  paneTitle: string
}): JSX.Element {
  const d = useDict()
  const hide = useHiddenPromptsStore((s) => s.hide)
  const tone = requestTone(request.kind)
  return (
    <PromptCard
      icon={ShieldWarningIcon}
      tone={tone}
      label={d.approvals.title}
      data-approval={request.id}
      title={requestText(d, request, paneTitle)}
      actions={<ApprovalActions request={request} size="sm" />}
      dismissLabel={d.approvals.decideLater}
      onDismiss={() => hide(approvalPromptKey(request.id))}
    >
      <RequestDetail request={request} />
    </PromptCard>
  )
}
