import { EnvelopeSimpleIcon } from '@phosphor-icons/react'
import type { MailItem } from '@shared/agents/mailApi'
import type { Dict } from '@shared/app/dict'
import { ageLabel } from '@shared/panes/paneStatus'
import { Hint } from '@/components/common/Hint'
import { Badge } from '@/components/ui/badge'
import { fmt, useDict } from '@/lib/app/useDict'
import { paneTitleIn } from '@/lib/layout/paneTitle'
import { itemsOf, useMailStore } from '@/stores/agents/mailStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

function pendingText(d: Dict, pending: MailItem['pending']): string {
  switch (pending) {
    case 'draft':
      return d.mail.pendingDraft
    case 'hibernated':
      return d.mail.pendingHibernated
    case 'idle-will-wake':
      return d.mail.pendingWillWake
    case 'rate-limited':
      return d.mail.pendingRateLimited
    case 'hooks-off':
      return d.mail.pendingHooksOff
    case 'no-agent':
      return d.mail.pendingNoAgent
    case 'working':
      return d.mail.pendingWorking
    default:
      return d.mail.pendingIdle
  }
}

function reasonText(d: Dict, reason: string | undefined): string {
  return reason?.startsWith('expired') ? d.mail.reasonExpired : d.mail.reasonClosed
}

function MailList({ items }: { items: MailItem[] }): JSX.Element {
  const d = useDict()
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const now = Date.now()
  return (
    <div>
      {items.map((item) => {
        const sender =
          (item.from.paneId ? paneTitleIn(byWorkspace, item.from.paneId) : item.from.label) ||
          d.mail.fromPane
        const detail =
          item.state === 'failed' ? reasonText(d, item.reason) : pendingText(d, item.pending)
        return (
          <div key={item.id}>
            {sender} · {ageLabel(now - Date.parse(item.ts))} · {detail}
          </div>
        )
      })}
      {items.some((item) => item.state === 'failed') ? <div>{d.mail.dismiss}</div> : null}
    </div>
  )
}

export function MailCount({ paneIds }: { paneIds: readonly string[] }): JSX.Element | null {
  const d = useDict()
  const byPane = useMailStore((s) => s.byPane)
  const items = itemsOf(byPane, paneIds)
  const queued = items.filter((item) => item.state === 'queued').length
  const failed = items.length - queued
  if (items.length === 0) return null
  const label =
    failed > 0
      ? failed === 1
        ? d.mail.failedOne
        : fmt(d.mail.failed, { n: failed })
      : queued === 1
        ? d.mail.countOne
        : fmt(d.mail.count, { n: queued })
  const dismiss = (event: React.MouseEvent): void => {
    if (failed === 0) return
    event.stopPropagation()
    for (const paneId of paneIds) void window.ostia.mail.dismiss(paneId)
  }
  return (
    <Hint label={<MailList items={items} />}>
      <Badge
        variant="secondary"
        className="h-4 gap-1 rounded-sm px-1 text-ui-xs text-warn-fg"
        role="img"
        aria-label={label}
        onClick={dismiss}
      >
        <EnvelopeSimpleIcon size={16} aria-hidden />
        {failed > 0 ? failed : queued}
      </Badge>
    </Hint>
  )
}
