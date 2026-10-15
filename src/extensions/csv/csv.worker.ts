import { parseTable } from './csvParse'

interface ParseRequest {
  bytes: ArrayBuffer
  delimiter: string
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (event) => {
  try {
    const text = new TextDecoder().decode(event.data.bytes)
    scope.postMessage({ ok: true, table: parseTable(text, event.data.delimiter) })
  } catch {
    scope.postMessage({ ok: false })
  }
}
