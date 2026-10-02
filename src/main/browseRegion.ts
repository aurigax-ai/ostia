import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard, ipcMain, nativeImage } from 'electron'
import {
  PICK_NOTE_MAX,
  type PickSendResult,
  captureStem,
  clip,
  nextPickReportNumber,
} from '../shared/pick'
import {
  REGION_IMAGE_MAX,
  type RegionCapture,
  type RegionCaptureOutcome,
  type RegionCopyResult,
  type RegionSendRequest,
  normalizeRegionRequest,
  regionBusMessage,
  regionCapture,
  regionCaptureRect,
  regionPageRect,
  renderRegionReport,
} from '../shared/regionCapture'
import { ownedGuest } from './browse'
import { REPORT_DIR_NAME } from './browsePick'
import { postBusMessage } from './bus'
import { getByPaneId } from './idRegistry'
import type { OriginReach } from './originAgents'
import { privateTmpDir } from './privateTmp'

const MAX_STORED_REGIONS = 5

interface StoredRegion {
  capture: RegionCapture
  paneId: string
  png: Buffer
}

let regionCounter = 0
const regions = new Map<string, StoredRegion>()

function nextRegionId(): string {
  regionCounter += 1
  return `region-${Date.now().toString(36)}-${regionCounter}`
}

function storeRegion(region: StoredRegion): void {
  regions.set(region.capture.id, region)
  while (regions.size > MAX_STORED_REGIONS) {
    const oldest = regions.keys().next().value
    if (oldest === undefined) break
    regions.delete(oldest)
  }
}

export async function captureRegion(
  guest: Electron.WebContents,
  hostZoom: number,
  paneId: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<RegionCaptureOutcome> {
  const req = normalizeRegionRequest(raw)
  if (!req) return { ok: false, error: 'invalid' }
  let image: Electron.NativeImage
  try {
    image = await guest.capturePage(regionCaptureRect(req.rect, hostZoom))
  } catch {
    return { ok: false, error: 'browser-not-ready' }
  }
  if (image.isEmpty()) return { ok: false, error: 'empty' }
  const png = image.toPNG()
  if (png.byteLength > REGION_IMAGE_MAX) return { ok: false, error: 'image-too-large' }
  const size = image.getSize()
  const capture = regionCapture({
    id: nextRegionId(),
    url: guest.getURL(),
    title: guest.getTitle(),
    rect: regionPageRect(req.rect, hostZoom, guest.getZoomFactor()),
    imageWidth: size.width,
    imageHeight: size.height,
    capturedAt: now,
  })
  storeRegion({ capture, paneId, png })
  return { ok: true, capture }
}

export function writeRegionReport(
  req: RegionSendRequest,
  senderWindowId: string,
  reaches: OriginReach,
): PickSendResult {
  const source = getByPaneId(req?.sourcePaneId)
  const target = getByPaneId(req?.targetPaneId)
  if (!source || source.windowId !== senderWindowId || !target) {
    return { ok: false, error: 'not-found' }
  }
  if (!reaches(senderWindowId, source.paneId, target.paneId)) {
    return { ok: false, error: 'not-found' }
  }
  const stored = regions.get(req.captureId)
  if (!stored || stored.paneId !== req.sourcePaneId) return { ok: false, error: 'capture-expired' }
  const note = clip(typeof req.note === 'string' ? req.note : '', PICK_NOTE_MAX)
  let path: string
  let imagePath: string
  try {
    const dir = privateTmpDir(REPORT_DIR_NAME)
    const stem = join(dir, captureStem(nextPickReportNumber(readdirSync(dir)), stored.capture.url))
    imagePath = `${stem}.png`
    writeFileSync(imagePath, stored.png, { mode: 0o600, flag: 'wx' })
    path = `${stem}.md`
    writeFileSync(path, renderRegionReport(stored.capture, note, imagePath), {
      mode: 0o600,
      flag: 'wx',
    })
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  postBusMessage(
    source.externalId,
    target.externalId,
    regionBusMessage(stored.capture, note, path, imagePath),
  )
  return { ok: true, path, imagePath }
}

export function copyRegionImage(
  paneId: string,
  captureId: string,
  senderWindowId: string,
): RegionCopyResult {
  if (getByPaneId(paneId)?.windowId !== senderWindowId) return { ok: false, error: 'not-found' }
  const stored = regions.get(captureId)
  if (!stored || stored.paneId !== paneId) return { ok: false, error: 'capture-expired' }
  clipboard.writeImage(nativeImage.createFromBuffer(stored.png))
  return { ok: true }
}

export function registerRegionIpc(browserPanes: Map<string, number>, reaches: OriginReach): void {
  ipcMain.handle('browser:region-capture', (e, paneId: string, req: unknown) => {
    const guest = ownedGuest(browserPanes, paneId, String(e.sender.id))
    if (!guest) return { ok: false, error: 'browser-not-ready' } satisfies RegionCaptureOutcome
    return captureRegion(guest, e.sender.getZoomFactor(), paneId, req)
  })
  ipcMain.handle('browser:region-send', (e, req: RegionSendRequest) =>
    writeRegionReport(req ?? ({} as RegionSendRequest), String(e.sender.id), reaches),
  )
  ipcMain.handle('browser:region-copy', (e, paneId: string, captureId: string) =>
    copyRegionImage(paneId, captureId, String(e.sender.id)),
  )
}
