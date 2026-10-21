import { needsImage, type SelectionCapture } from '@shared/browser/selection'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import type { BarAnchor } from '@/lib/agents/barAnchor'
import { selectionClipboard } from '@/lib/agents/captureClipboard'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { registerSelectionCopier } from '@/lib/agents/selectionCopiers'
import { sendSelectionToPane } from '@/lib/agents/sendPick'
import { fmt, useDict } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'
import { RegionActionBar } from './RegionActionBar'

const STATUS_MS = 6000
const DEFAULT_ANCHOR: BarAnchor = { left: 12, top: 40, bottom: 40 }

interface PendingSelection {
  capture: SelectionCapture
  image?: Uint8Array
  anchor: BarAnchor
}

export interface SelectionSend {
  open: (capture: SelectionCapture, image?: Uint8Array, anchor?: BarAnchor) => void
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
  const [pending, setPending] = useState<PendingSelection | null>(null)
  const [status, setStatus] = useTransientStatus(STATUS_MS)

  const open = useCallback(
    (capture: SelectionCapture, image?: Uint8Array, anchor: BarAnchor = DEFAULT_ANCHOR) => {
      setStatus(null)
      setPending({ capture, image, anchor })
    },
    [setStatus],
  )

  const copy = useCallback(async (): Promise<string | null> => {
    if (!pending) return null
    const clip = selectionClipboard(pending.capture, pending.image)
    if (!clip || !(await window.ostia.clipboard.writeCapture(clip))) {
      throw new Error(d.send.copyFailed)
    }
    return needsImage(pending.capture) ? d.send.copiedImage : d.send.copied
  }, [pending, d])

  useEffect(() => {
    if (!pending || !selectionClipboard(pending.capture, pending.image)) return
    return registerSelectionCopier(paneId, () =>
      copy()
        .then(setStatus, (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)))
        .finally(() => setPending(null)),
    )
  }, [pending, paneId, copy, setStatus])

  const send = async (target: PickTarget, note: string): Promise<void> => {
    if (!pending) return
    const res = await sendSelectionToPane({
      capture: pending.capture,
      image: pending.image,
      sourcePaneId: paneId,
      targetPaneId: target.paneId,
      via: target.via,
      note,
    })
    if (!res.ok) throw new Error(fmt(d.send.sendFailed, { reason: res.error }))
    setStatus(fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }))
  }

  const panel = pending ? (
    <RegionActionBar
      workspaceId={workspaceId}
      anchor={pending.anchor}
      onCopy={copy}
      onSend={send}
      onClose={() => setPending(null)}
    />
  ) : null

  const statusLine = status ? (
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
