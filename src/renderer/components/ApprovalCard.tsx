import { ShieldWarningIcon } from '@phosphor-icons/react'
import type { ApprovalRequest } from '@shared/approvals'
import { fmt, useDict } from '../i18n/useDict'
import { useApprovalsStore } from '../stores/approvalsStore'
import { Button } from './ui/button'

export function capLabel(caps: Record<string, string>, cap: string): string {
  return caps[cap] ?? cap
}

export function ApprovalCard({
  request,
  paneTitle,
}: {
  request: ApprovalRequest
  paneTitle: string
}): JSX.Element {
  const d = useDict()
  const answer = useApprovalsStore((s) => s.answer)
  const kind = request.kind ?? 'capability'
  const destructive = request.caps.includes('destructive')
  const subject = request.subject ?? ''
  return (
    <section
      aria-label={d.approvals.title}
      className="motion-overlay absolute right-2 bottom-2 left-2 z-20 flex flex-col gap-2 rounded-md border border-line bg-surface-3 p-3 text-fg text-ui-sm shadow-md"
    >
      <div className="flex items-center gap-2">
        <ShieldWarningIcon size={16} aria-hidden />
        <span className="font-medium">{d.approvals.title}</span>
      </div>
      {kind === 'capability' ? (
        <p>
          {fmt(d.approvals.wants, { pane: paneTitle })}{' '}
          {request.caps.map((cap) => capLabel(d.approvals.caps, cap)).join(', ')}
        </p>
      ) : (
        <p className="[overflow-wrap:anywhere]">
          {fmt(kind === 'sandbox-domain' ? d.approvals.sandboxDomain : d.approvals.sandboxPort, {
            pane: paneTitle,
            subject,
          })}
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
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void answer(request.id, 'deny')}>
          {d.approvals.deny}
        </Button>
        {kind === 'capability' ? (
          <>
            {destructive ? null : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void answer(request.id, 'session')}
              >
                {d.approvals.allowSession}
              </Button>
            )}
            <Button size="sm" onClick={() => void answer(request.id, 'once')}>
              {d.approvals.allowOnce}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={() => void answer(request.id, 'session')}>
              {d.approvals.allowUntilRestart}
            </Button>
            <Button size="sm" onClick={() => void answer(request.id, 'workspace')}>
              {d.approvals.allowWorkspace}
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
