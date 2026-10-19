import { serveWorker } from '@aurigax-ai/ostia-extension-sdk/viewer'
import { OFFICE_LIMITS } from './officeLimits'
import type { OutlineWords } from './outlineHtml'
import { readPresentation } from './presentationModel'

serveWorker<{ bytes: ArrayBuffer; words: OutlineWords }>(({ bytes, words }) =>
  readPresentation(new Uint8Array(bytes), OFFICE_LIMITS, words),
)
