import { StatusLine } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'
import { useSessionStaysStore } from '@/stores/agents/sessionStaysStore'

export function useSessionStaysStatus(paneId: string): JSX.Element | null {
  const d = useDict()
  const stays = useSessionStaysStore((s) => s.byPane[paneId] === true)
  const dismiss = useSessionStaysStore((s) => s.dismiss)
  if (!stays) return null
  return (
    <div className="absolute inset-x-0 top-0 z-20">
      <StatusLine
        data-session-stays=""
        aria-label={d.pane.sessionStaysLabel}
        onDismiss={() => dismiss(paneId)}
      >
        {d.pane.sessionStays}
      </StatusLine>
    </div>
  )
}
