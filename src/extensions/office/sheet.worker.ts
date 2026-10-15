import { OFFICE_LIMITS } from './officeLimits'
import { readWorkbook } from './sheetModel'

interface ReadRequest {
  bytes: ArrayBuffer
  extension: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ReadRequest>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (event) => {
  const { bytes, extension } = event.data
  scope.postMessage(readWorkbook(new Uint8Array(bytes), extension, OFFICE_LIMITS))
}
