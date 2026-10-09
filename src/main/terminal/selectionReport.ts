import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { clip } from '../../shared/pick'
import type { RedactText } from '../../shared/redactionTargets'
import {
  SELECTION_IMAGE_MAX,
  SELECTION_NOTE_MAX,
  type SelectionSendRequest,
  type SelectionSendResult,
  isPng,
  needsImage,
  normalizeSelection,
  renderSelectionReport,
  selectionBusMessage,
} from '../../shared/selection'
import { postBusMessage } from '../agents/bus'
import type { OriginReach } from '../agents/originAgents'
import { REPORT_DIR_NAME } from '../browser/browsePick'
import { getByPaneId } from '../control/idRegistry'
import { privateTmpDir } from '../platform/privateTmp'

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}

function freeStem(dir: string): string {
  for (let n = 1; ; n++) {
    const stem = join(dir, `selection-${n}`)
    if (!existsSync(`${stem}.md`) && !existsSync(`${stem}.png`)) return stem
  }
}

const asWritten: RedactText = async (text) => text

export async function writeSelectionReport(
  req: SelectionSendRequest,
  senderWindowId: string,
  reaches: OriginReach,
  now: Date = new Date(),
  redact: RedactText = asWritten,
): Promise<SelectionSendResult> {
  const source = getByPaneId(req?.sourcePaneId)
  const target = getByPaneId(req?.targetPaneId)
  if (!source || source.windowId !== senderWindowId || !target) {
    return { ok: false, error: 'not-found' }
  }
  if (!reaches(senderWindowId, source.paneId, target.paneId)) {
    return { ok: false, error: 'not-found' }
  }
  const capture = normalizeSelection(req.capture)
  if (!capture) return { ok: false, error: 'invalid' }
  const image = needsImage(capture) ? asBytes(req.image) : null
  if (needsImage(capture)) {
    if (!image || !isPng(image)) return { ok: false, error: 'invalid' }
    if (image.byteLength > SELECTION_IMAGE_MAX) return { ok: false, error: 'image-too-large' }
  }
  const note = clip(typeof req.note === 'string' ? req.note : '', SELECTION_NOTE_MAX)
  let path: string
  let imagePath: string | null = null
  let message: string
  try {
    const stem = freeStem(privateTmpDir(REPORT_DIR_NAME))
    if (image) {
      imagePath = `${stem}.png`
      writeFileSync(imagePath, image, { mode: 0o600, flag: 'wx' })
    }
    path = `${stem}.md`
    const report = await redact(renderSelectionReport(capture, note, imagePath, now))
    message = selectionBusMessage(capture, await redact(note), path, imagePath)
    writeFileSync(path, report, { mode: 0o600, flag: 'wx' })
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  postBusMessage(source.externalId, target.externalId, message)
  return { ok: true, path, imagePath }
}

export function registerSelectionIpc(reaches: OriginReach, redact: RedactText): void {
  ipcMain.handle('selection:send', (e, req: SelectionSendRequest) =>
    writeSelectionReport(
      req ?? ({} as SelectionSendRequest),
      String(e.sender.id),
      reaches,
      new Date(),
      redact,
    ),
  )
}
