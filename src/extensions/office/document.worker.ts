import { serveWorker } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { readDocument } from './docModel'
import { OFFICE_LIMITS } from './officeLimits'
import type { OutlineWords } from './outlineHtml'

serveWorker<{ bytes: ArrayBuffer; words: OutlineWords }>(({ bytes, words }) =>
  readDocument(new Uint8Array(bytes), OFFICE_LIMITS, words),
)
