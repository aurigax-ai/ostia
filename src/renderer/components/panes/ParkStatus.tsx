import { PARKED_PANEL_EXTENSION_ID } from '@shared/park/park'
import type { JSX } from 'react'
import { StatusAction, StatusLine } from '@/components/common/StatusLine'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { useParkStore } from '@/stores/workspaces/parkStore'

export function useParkStatus(
  paneId: string,
  workspaceId: string,
  activePaneId: string | null,
): JSX.Element | null {
  const d = useDict()
  const notice = useParkStore((s) => s.notice)
  const dismiss = useParkStore((s) => s.dismissNotice)
  if (!notice || notice.workspaceId !== workspaceId) return null
  if (notice.kind !== 'parked' ? notice.paneId !== paneId : paneId !== activePaneId) return null
  if (notice.kind === 'resumeFailed') {
    return (
      <div className="absolute inset-x-0 top-0 z-20">
        <StatusLine
          tone="warn"
          data-park-status="resume-failed"
          onDismiss={dismiss}
          aria-label={d.pane.parkLabel}
        >
          {fmt(d.pane.parkResumeFailed, {
            title: notice.title,
            reason: d.pane.parkResumeReasons[notice.reason],
          })}
        </StatusLine>
      </div>
    )
  }
  if (notice.kind === 'refused') {
    return (
      <div className="absolute inset-x-0 top-0 z-20">
        <StatusLine
          tone="warn"
          data-park-status="refused"
          onDismiss={dismiss}
          aria-label={d.pane.parkLabel}
        >
          {fmt(d.pane.parkRefused, {
            title: notice.title,
            reason: d.pane.parkReasons[notice.reason],
          })}
        </StatusLine>
      </div>
    )
  }
  return (
    <div className="absolute inset-x-0 top-0 z-20">
      <StatusLine
        data-park-status="parked"
        aria-label={d.pane.parkLabel}
        actions={
          <StatusAction
            onClick={() => {
              useSidePanelStore
                .getState()
                .showRight(PARKED_PANEL_EXTENSION_ID, { workspaceId, path: 'parked' })
              dismiss()
            }}
          >
            {d.pane.parkShow}
          </StatusAction>
        }
        onDismiss={dismiss}
      >
        {fmt(d.pane.parked, { title: notice.title })}
      </StatusLine>
    </div>
  )
}
