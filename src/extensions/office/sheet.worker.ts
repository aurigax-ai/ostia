import { serveWorker } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { OFFICE_LIMITS } from './officeLimits'
import { readWorkbook } from './sheetModel'

serveWorker<{ bytes: ArrayBuffer }>(({ bytes }) =>
  readWorkbook(new Uint8Array(bytes), OFFICE_LIMITS),
)
