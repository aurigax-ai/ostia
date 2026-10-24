import { selectionLabel } from '@shared/browser/selection'
import type { ViewerSelectionState } from '@shared/files/filesApi'
import { sendViewerSelectionToPane } from '@/lib/agents/sendPick'
import type { CaptureAdapter, CloseReason } from './captureSession'

const GUEST_OWNS = new Set<CloseReason>(['source-gone', 'replaced', 'guest-focus'])

export function viewerAdapter(
  paneId: string,
  selection: ViewerSelectionState,
  takeFocus: boolean,
): CaptureAdapter {
  return {
    anchor: selection.anchor,
    takeFocus,
    highlight: null,
    copy: async () => ({ ok: true, status: await window.ostia.viewers.copySelection(paneId) }),
    send: async (target, note) => {
      const res = await sendViewerSelectionToPane({
        paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
        label: selectionLabel(selection.capture),
      })
      return res.ok ? { ok: true, inserted: res.inserted } : { ok: false, error: res.error }
    },
    clear: (reason) => {
      if (!GUEST_OWNS.has(reason)) window.ostia.viewers.clearSelection(paneId)
    },
  }
}
