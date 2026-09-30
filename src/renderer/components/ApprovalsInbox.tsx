import {
  type ApprovalKind,
  type ApprovalOutcome,
  type ApprovalRequest,
  answersFor,
} from '@shared/approvals'
import type { Dict } from '../i18n/dict'
import { useDict } from '../i18n/useDict'
import { revealPane } from '../lib/workspaceActivity'
import { useApprovalsStore } from '../stores/approvalsStore'
import { capLabel } from './ApprovalCard'
import { Button } from './ui/button'

const HISTORY_SHOWN = 10

function outcomeLabel(d: Dict, outcome: ApprovalOutcome, kind: ApprovalKind): string {
  switch (outcome) {
    case 'once':
      return d.approvals.outcomeOnce
    case 'session':
      return kind === 'capability' ? d.approvals.outcomeSession : d.approvals.outcomeUntilRestart
    case 'workspace':
      return d.approvals.outcomeWorkspace
    case 'deny':
      return d.approvals.outcomeDeny
    case 'auto':
      return d.approvals.outcomeAuto
    case 'timeout':
      return d.approvals.outcomeTimeout
  }
}

export function ApprovalsInbox({
  whereOf,
  time,
  onReveal,
}: {
  whereOf: (paneId: string) => string | null
  time: Intl.DateTimeFormat
  onReveal: () => void
}): JSX.Element | null {
  const d = useDict()
  const pending = useApprovalsStore((s) => s.pending)
  const history = useApprovalsStore((s) => s.history)
  const answer = useApprovalsStore((s) => s.answer)
  const revoke = useApprovalsStore((s) => s.revoke)
  if (pending.length === 0 && history.length === 0) return null
  const caps = (list: readonly string[]): string =>
    list.map((cap) => capLabel(d.approvals.caps, cap)).join(', ')
  const what = (req: ApprovalRequest): string =>
    (req.kind ?? 'capability') === 'capability' ? caps(req.caps) : (req.subject ?? '')

  return (
    <section
      aria-label={d.approvals.inbox}
      className="flex flex-col gap-1 border-line border-b pb-2"
    >
      {pending.length > 0 ? (
        <>
          <span className="px-1.5 pt-1 font-medium text-fg-muted text-ui-xs">
            {d.approvals.inbox}
          </span>
          <ul className="flex flex-col gap-1">
            {pending.map((req) => (
              <li key={req.id} className="flex flex-col gap-1 rounded-sm bg-surface-2 p-1.5">
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto justify-start truncate p-0 font-normal text-fg-muted text-ui-xs hover:text-fg"
                  onClick={() => {
                    if (revealPane(req.paneId)) onReveal()
                  }}
                >
                  {whereOf(req.paneId) ?? req.paneId}
                </Button>
                <span className="text-ui-sm [overflow-wrap:anywhere]">
                  {what(req)}: {req.action}
                </span>
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="xs" onClick={() => void answer(req.id, 'deny')}>
                    {d.approvals.deny}
                  </Button>
                  {answersFor(req.kind).includes('once') ? (
                    <Button size="xs" onClick={() => void answer(req.id, 'once')}>
                      {d.approvals.allowOnce}
                    </Button>
                  ) : (
                    <Button size="xs" onClick={() => void answer(req.id, 'workspace')}>
                      {d.approvals.allowWorkspace}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {history.length > 0 ? (
        <>
          <span className="px-1.5 pt-1 font-medium text-fg-muted text-ui-xs">
            {d.approvals.history}
          </span>
          <ul className="flex flex-col">
            {history.slice(0, HISTORY_SHOWN).map((record) => (
              <li key={record.id} className="flex items-center gap-2 px-1.5 py-1 text-ui-xs">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-fg">
                    {what(record)}: {record.action}
                  </span>
                  <span className="truncate text-fg-muted tabular-nums">
                    {outcomeLabel(d, record.outcome, record.kind ?? 'capability')} ·{' '}
                    {time.format(new Date(record.answeredAt))} ·{' '}
                    {whereOf(record.paneId) ?? d.attention.closedPane}
                  </span>
                </span>
                {record.revocable ? (
                  <Button variant="outline" size="xs" onClick={() => void revoke(record.id)}>
                    {d.approvals.revoke}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
