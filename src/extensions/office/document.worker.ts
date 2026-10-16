import { serveWorker } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { readDocument } from './docModel'
import { OFFICE_LIMITS } from './officeLimits'

serveWorker<{ bytes: ArrayBuffer }>(({ bytes }) =>
  readDocument(new Uint8Array(bytes), OFFICE_LIMITS),
)
