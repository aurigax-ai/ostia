import { APPLIED_MAX_BYTES, APPLIED_RETENTION_MS, type Applied, parseAppliedLine } from './applied'
import { JsonlLog } from './jsonlLog'

const APPLIED_FILE = 'applied.jsonl'

export class AppliedStore {
  private readonly log: JsonlLog<Applied>

  constructor(dir: string | null, now: () => number, maxBytes = APPLIED_MAX_BYTES) {
    this.log = new JsonlLog({
      dir,
      file: APPLIED_FILE,
      now,
      retentionMs: APPLIED_RETENTION_MS,
      maxBytes,
      parse: parseAppliedLine,
    })
  }

  list(): Applied[] {
    return this.log.list()
  }

  add(record: Applied): void {
    this.log.add(record)
  }

  clear(): void {
    this.log.clear()
  }
}
