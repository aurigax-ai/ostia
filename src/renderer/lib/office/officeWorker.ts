import { OFFICE_LIMITS } from './officeLimits'
import { type WorkbookResult, readWorkbook } from './sheetModel'

export interface WorkbookRequest {
  bytes: ArrayBuffer
  extension: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkbookRequest>) => void) | null
  postMessage: (result: WorkbookResult) => void
}

scope.onmessage = (event) => {
  const { bytes, extension } = event.data
  scope.postMessage(readWorkbook(new Uint8Array(bytes), extension, OFFICE_LIMITS))
}
