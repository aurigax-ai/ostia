import { type SelectionCapture, selectionLabel } from '@shared/browser/selection'
import { type ReactNode, useCallback, useState } from 'react'
import { NoticeSlot } from '@/components/common/NoticeSlot'
import { StatusLine } from '@/components/common/StatusLine'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { sendSelectionToPane } from '@/lib/agents/sendPick'
import { fmt, useDict } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'
import { PickSendPanel, useAgentTargets, useNoAgentsText } from './PickSendPanel'

const STATUS_MS = 6000

interface PendingSelection {
  id: string
  capture: SelectionCapture
  image?: Uint8Array
}

let pendingCounter = 0

export interface SelectionSend {
  open: (capture: SelectionCapture, image?: Uint8Array) => void
  notify: (message: string) => void
  panel: ReactNode
  status: ReactNode
}

export function useSelectionSend(
  workspaceId: string,
  paneId: string,
  overlay = false,
): SelectionSend {
  const d = useDict()
  const targets = useAgentTargets(workspaceId)
  const noTargets = useNoAgentsText(workspaceId)
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useTransientStatus(STATUS_MS)
  const [failure, setFailure] = useState<string | null>(null)

  const open = useCallback(
    (capture: SelectionCapture, image?: Uint8Array) => {
      pendingCounter += 1
      setStatus(null)
      setFailure(null)
      setPending({ id: `${paneId}-${pendingCounter}`, capture, image })
    },
    [paneId, setStatus],
  )

  const send = async (target: PickTarget, note: string): Promise<void> => {
    if (!pending) return
    setSending(true)
    try {
      const res = await sendSelectionToPane({
        capture: pending.capture,
        image: pending.image,
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
      })
      if (res.ok) {
        setPending(null)
        setStatus(
          fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }),
        )
      } else {
        setFailure(fmt(d.send.sendFailed, { reason: res.error }))
      }
    } finally {
      setSending(false)
    }
  }

  const panel = (
    <NoticeSlot>
      {pending ? (
        <PickSendPanel
          key={pending.id}
          id={pending.id}
          summary={selectionLabel(pending.capture)}
          noteLabel={d.viewer.note}
          notePlaceholder={d.viewer.notePlaceholder}
          closeLabel={d.viewer.discard}
          targets={targets}
          noTargets={noTargets}
          sending={sending}
          onSend={(t, note) => void send(t, note)}
          onClose={() => setPending(null)}
        />
      ) : null}
    </NoticeSlot>
  )

  const statusLine = failure ? (
    <StatusLine tone="error" onDismiss={() => setFailure(null)}>
      {failure}
    </StatusLine>
  ) : status ? (
    <StatusLine onDismiss={() => setStatus(null)}>{status}</StatusLine>
  ) : null

  const shown =
    statusLine && overlay ? (
      <div className="absolute inset-x-0 top-0 z-20">{statusLine}</div>
    ) : (
      statusLine
    )

  return { open, notify: setStatus, panel, status: shown }
}
