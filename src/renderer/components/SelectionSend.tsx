import { type SelectionCapture, selectionLabel } from '@shared/selection'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import type { PickTarget } from '../lib/pickTargets'
import { sendSelectionToPane } from '../lib/sendPick'
import { PickSendPanel, useAgentTargets } from './PickSendPanel'

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

export function useSelectionSend(workspaceId: string, paneId: string): SelectionSend {
  const d = useDict()
  const targets = useAgentTargets(workspaceId)
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!status) return
    const timer = setTimeout(() => setStatus(null), STATUS_MS)
    return () => clearTimeout(timer)
  }, [status])

  const open = useCallback(
    (capture: SelectionCapture, image?: Uint8Array) => {
      pendingCounter += 1
      setStatus(null)
      setPending({ id: `${paneId}-${pendingCounter}`, capture, image })
    },
    [paneId],
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
        note,
      })
      if (res.ok) {
        setPending(null)
        setStatus(
          fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }),
        )
      } else {
        setStatus(fmt(d.send.sendFailed, { reason: res.error }))
      }
    } finally {
      setSending(false)
    }
  }

  const panel = pending ? (
    <PickSendPanel
      key={pending.id}
      id={pending.id}
      summary={selectionLabel(pending.capture)}
      noteLabel={d.viewer.note}
      notePlaceholder={d.viewer.notePlaceholder}
      closeLabel={d.viewer.discard}
      targets={targets}
      sending={sending}
      onSend={(t, note) => void send(t, note)}
      onClose={() => setPending(null)}
    />
  ) : null

  const statusLine = status ? <output className="viewer-status">{status}</output> : null

  return { open, notify: setStatus, panel, status: statusLine }
}
