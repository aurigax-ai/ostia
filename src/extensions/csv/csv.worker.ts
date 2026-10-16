import { serveWorker } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { parseTable } from './csvParse'

serveWorker<{ bytes: ArrayBuffer; delimiter: string }>(({ bytes, delimiter }) => {
  try {
    return { ok: true, table: parseTable(new TextDecoder().decode(bytes), delimiter) }
  } catch {
    return { ok: false }
  }
})
