import { IconButton } from '@/components/common/IconButton'
import { fmt, useDict } from '@/i18n/useDict'
import { useApprovalsStore } from '@/stores/agents/approvalsStore'
import { useQuestionsStore } from '@/stores/agents/questionsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { SquaresFourIcon } from '@phosphor-icons/react'

export function useNeedsYouCount(): number {
  const questions = useQuestionsStore((s) => s.pending.length)
  const approvals = useApprovalsStore((s) => s.pending.length)
  return questions + approvals
}

export function DashboardButton(): JSX.Element {
  const d = useDict()
  const active = useUIStore((s) => s.dashboardActive)
  const toggle = useUIStore((s) => s.toggleDashboard)
  const waiting = useNeedsYouCount()
  return (
    <span className="count-wrap">
      <IconButton
        size="bar"
        icon={SquaresFourIcon}
        command="dashboard.toggle"
        label={waiting > 0 ? fmt(d.dashboard.openPending, { n: waiting }) : d.dashboard.open}
        aria-pressed={active}
        onClick={toggle}
      />
      {waiting > 0 ? <span className="count-dot" aria-hidden="true" /> : null}
    </span>
  )
}
