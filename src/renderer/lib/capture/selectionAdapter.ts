import { needsImage, type SelectionCapture } from '@shared/browser/selection'
import { selectionClipboard } from '@/lib/agents/captureClipboard'
import { sendSelectionToPane } from '@/lib/agents/sendPick'
import { currentDict } from '@/lib/app/useDict'
import type { BarAnchor } from './barAnchor'
import type { CaptureAdapter } from './captureSession'

interface SelectionAdapterOptions {
  paneId: string
  capture: SelectionCapture
  image?: Uint8Array
  anchor: BarAnchor | null
}

export function selectionAdapter({
  paneId,
  capture,
  image,
  anchor,
}: SelectionAdapterOptions): CaptureAdapter {
  return {
    anchor,
    takeFocus: true,
    highlight: null,
    copy: async () => {
      const d = currentDict()
      const clip = selectionClipboard(capture, image)
      if (!clip || !(await window.ostia.clipboard.writeCapture(clip))) {
        return { ok: false, error: d.send.copyFailed }
      }
      return { ok: true, status: needsImage(capture) ? d.send.copiedImage : d.send.copied }
    },
    send: async (target, note) => {
      const res = await sendSelectionToPane({
        capture,
        image,
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
      })
      return res.ok ? { ok: true, inserted: res.inserted } : { ok: false, error: res.error }
    },
    clear: () => undefined,
  }
}
