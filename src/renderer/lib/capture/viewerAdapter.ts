import { selectionLabel } from '@shared/browser/selection'
import type { ViewerSelectionState } from '@shared/files/filesApi'
import { sendViewerSelectionToPane } from '@/lib/agents/sendPick'
import { currentDict } from '@/lib/app/useDict'
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
    copy: async () => {
      const label = await window.ostia.viewers.copySelection(paneId)
      return label ? { ok: true, label } : { ok: false, error: currentDict().send.copyFailed }
    },
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
