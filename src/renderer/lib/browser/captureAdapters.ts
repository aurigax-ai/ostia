import type { Dict } from '@shared/app/dict'
import type { PickCapture, PickCopyResult } from '@shared/browser/pick'
import type { RegionCapture } from '@shared/browser/regionCapture'
import type { PageSelection } from '@shared/browser/selection'
import { sendPickToPane, sendRegionToPane, sendSelectionToPane } from '@/lib/agents/sendPick'
import { fmt } from '@/lib/app/useDict'
import type { BarAnchor } from '@/lib/capture/barAnchor'
import type { CaptureAdapter, CaptureHighlight, CaptureResult } from '@/lib/capture/captureSession'
import { useSettingsStore } from '@/stores/app/settingsStore'

interface AdapterOptions {
  paneId: string
  d: Dict
  anchor: BarAnchor | null
}

function pickCopied(d: Dict, res: PickCopyResult): CaptureResult {
  if (!res.ok) return { ok: false, error: fmt(d.browser.pickCopyFailed, { reason: res.error }) }
  if (res.kind === 'table') {
    return { ok: true, label: d.browser.pickCopiedTable }
  }
  return {
    ok: true,
    label: res.kind === 'image' ? d.browser.pickCopiedImage : d.browser.pickCopiedReport,
  }
}

function failed(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

export function pickAdapter(
  { paneId, d, anchor }: AdapterOptions,
  capture: PickCapture,
  highlight: CaptureHighlight | null,
): CaptureAdapter {
  return {
    anchor,
    takeFocus: true,
    highlight,
    copy: async () => pickCopied(d, await window.ostia.browser.pickCopy(paneId, capture.id)),
    send: async (target, note) => {
      const res = await sendPickToPane({
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
        attachImage: useSettingsStore.getState().browser.attachCaptureImage,
        capture,
      })
      return res.ok ? { ok: true, inserted: res.inserted } : failed(res.error)
    },
    clear: () => undefined,
  }
}

export function regionAdapter(
  { paneId, d, anchor }: AdapterOptions,
  capture: RegionCapture,
  highlight: CaptureHighlight,
): CaptureAdapter {
  return {
    anchor,
    takeFocus: true,
    highlight,
    copy: async () => {
      const res = await window.ostia.browser.regionCopy(paneId, capture.id)
      return res.ok
        ? { ok: true, label: d.browser.imageCopied }
        : failed(fmt(d.browser.imageCopyFailed, { reason: res.error }))
    },
    send: async (target, note) => {
      const res = await sendRegionToPane({
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
        attachImage: useSettingsStore.getState().browser.attachCaptureImage,
        capture,
      })
      return res.ok ? { ok: true, inserted: res.inserted } : failed(res.error)
    },
    clear: () => undefined,
  }
}

export function pageTextAdapter(
  { paneId, d, anchor }: AdapterOptions,
  selection: PageSelection,
): CaptureAdapter {
  return {
    anchor,
    takeFocus: true,
    highlight: null,
    copy: async () =>
      (await window.ostia.clipboard.writeCapture({ text: selection.capture.text }))
        ? { ok: true, label: d.send.copied }
        : failed(d.send.copyFailed),
    send: async (target, note) => {
      const res = await sendSelectionToPane({
        sourcePaneId: paneId,
        targetPaneId: target.paneId,
        via: target.via,
        note,
        capture: selection.capture,
      })
      return res.ok ? { ok: true, inserted: res.inserted } : failed(res.error)
    },
    clear: () => undefined,
  }
}
