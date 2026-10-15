import { OFFICE_LIMITS } from './officeLimits'
import type { WorkbookRequest } from './officeWorker'
import OfficeWorker from './officeWorker?worker'
import type { WorkbookResult } from './sheetModel'

export interface WorkbookParse {
  result: Promise<WorkbookResult>
  cancel: () => void
}

export function parseWorkbook(
  data: Uint8Array,
  extension: string,
  worker: Worker = new OfficeWorker(),
): WorkbookParse {
  let timer = 0
  const stop = (): void => {
    window.clearTimeout(timer)
    worker.terminate()
  }
  const result = new Promise<WorkbookResult>((resolve) => {
    const finish = (outcome: WorkbookResult): void => {
      stop()
      resolve(outcome)
    }
    if (data.byteLength > OFFICE_LIMITS.fileBytes) {
      finish({ ok: false, problem: 'too-large' })
      return
    }
    timer = window.setTimeout(
      () => finish({ ok: false, problem: 'timeout' }),
      OFFICE_LIMITS.parseMs,
    )
    worker.onmessage = (event: MessageEvent<WorkbookResult>) => finish(event.data)
    worker.onerror = () => finish({ ok: false, problem: 'failed' })
    const copy = data.slice()
    const request: WorkbookRequest = { bytes: copy.buffer, extension }
    worker.postMessage(request, [copy.buffer])
  })
  return { result, cancel: stop }
}
