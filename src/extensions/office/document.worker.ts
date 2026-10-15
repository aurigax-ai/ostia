import { readDocument } from './docModel'
import { OFFICE_LIMITS } from './officeLimits'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer }>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (event) => {
  void readDocument(new Uint8Array(event.data.bytes), OFFICE_LIMITS).then((result) =>
    scope.postMessage(result),
  )
}
