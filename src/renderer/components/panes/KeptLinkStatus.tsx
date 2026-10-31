import { StatusAction, StatusLine } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'
import { useKeptLinkStore } from '@/stores/terminal/keptLinkStore'

export function useKeptLinkStatus(paneId: string): JSX.Element | null {
  const d = useDict()
  const link = useKeptLinkStore((s) => s.byPane[paneId])
  if (!link) return null
  const failed = link === 'failed'
  return (
    <div className="absolute inset-x-0 top-0 z-20">
      <StatusLine
        data-kept-link={link}
        aria-label={d.pane.keptLinkLabel}
        tone={failed ? 'warn' : 'muted'}
        actions={
          failed ? (
            <StatusAction onClick={() => window.ostia.pty.retryLink(paneId)}>
              {d.pane.keptLinkRetry}
            </StatusAction>
          ) : null
        }
      >
        {failed ? d.pane.keptLinkFailed : d.pane.keptLinkReconnecting}
      </StatusLine>
    </div>
  )
}
