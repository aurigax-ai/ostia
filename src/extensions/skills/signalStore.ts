import { JsonlLog } from './jsonlLog'
import {
  parseSignalLine,
  SIGNAL_RETENTION_MS,
  SIGNALS_MAX_BYTES,
  type Signal,
  type SignalDraft,
} from './signal'

export const SIGNALS_FILE = 'signals.jsonl'

export class SignalStore {
  private readonly log: JsonlLog<Signal>
  private next: number

  constructor(dir: string | null, now: () => number, maxBytes = SIGNALS_MAX_BYTES) {
    this.log = new JsonlLog({
      dir,
      file: SIGNALS_FILE,
      now,
      retentionMs: SIGNAL_RETENTION_MS,
      maxBytes,
      parse: parseSignalLine,
    })
    this.next = this.log.list().reduce((max, s) => Math.max(max, Number(s.id.slice(1))), 0) + 1
  }

  list(): Signal[] {
    return this.log
      .list()
      .map((s) => ({ ...s, stacks: [...s.stacks] }))
      .reverse()
  }

  add(draft: SignalDraft): Signal {
    const signal: Signal = { ...draft, id: `s${this.next}` }
    this.next += 1
    this.log.add(signal)
    return signal
  }

  remove(id: string): boolean {
    return this.log.remove((s) => s.id === id)
  }

  clear(): void {
    this.log.clear()
  }
}
