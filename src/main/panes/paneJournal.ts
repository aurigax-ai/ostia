import { closingLine, STATUS_MESSAGE_MAX } from '../../shared/agents/closingLine'

export const JOURNAL_EVENTS_MAX = 20
export const JOURNAL_CURSORS_MAX = 1000

export type JournalEvent =
  | { kind: 'state'; state: string; from?: string }
  | { kind: 'command'; exitCode?: number }
  | { kind: 'closing' }
  | { kind: 'mail' }

export type StampedEvent = JournalEvent & { at: number; seq: number }

interface PaneRecord {
  ring: StampedEvent[]
  state?: string
  stateAt?: number
  changedAt?: number
  running?: boolean
  explicit?: string
  stop?: string
}

export type JournalChange =
  | { kind: 'attention'; attention: { state?: string; message?: string } }
  | { kind: 'state' }
  | { kind: 'closed' }

export interface JournalDeps {
  terminal: (paneId: string) => { running: boolean; lastExitCode?: number } | undefined
  now: () => number
}

export class PaneJournal {
  private readonly panes = new Map<string, PaneRecord>()
  private readonly cursors = new Map<string, number>()
  private seq = 0
  private readonly listeners = new Set<(paneId: string, event: StampedEvent) => void>()

  constructor(private readonly deps: JournalDeps) {}

  private record(paneId: string): PaneRecord {
    let record = this.panes.get(paneId)
    if (!record) {
      record = { ring: [] }
      this.panes.set(paneId, record)
    }
    return record
  }

  private push(paneId: string, event: JournalEvent): void {
    const record = this.record(paneId)
    const stamped: StampedEvent = { ...event, at: this.deps.now(), seq: ++this.seq }
    record.ring.push(stamped)
    if (record.ring.length > JOURNAL_EVENTS_MAX) record.ring.shift()
    for (const listener of [...this.listeners]) listener(paneId, stamped)
  }

  subscribe(listener: (paneId: string, event: StampedEvent) => void): void {
    this.listeners.add(listener)
  }

  onChange = (paneId: string, change: JournalChange): void => {
    if (change.kind === 'closed') {
      this.forget(paneId)
      return
    }
    const record = this.record(paneId)
    if (change.kind === 'attention') {
      const state = change.attention.state ?? 'idle'
      if (state === record.state) return
      const from = record.state
      record.state = state
      record.stateAt = this.deps.now()
      record.changedAt = record.stateAt
      if (state === 'working') {
        record.explicit = undefined
        record.stop = undefined
      }
      this.push(paneId, { kind: 'state', state, ...(from ? { from } : {}) })
      return
    }
    const terminal = this.deps.terminal(paneId)
    if (!terminal) return
    if (record.running === true && !terminal.running) {
      this.push(paneId, {
        kind: 'command',
        ...(terminal.lastExitCode === undefined ? {} : { exitCode: terminal.lastExitCode }),
      })
    }
    if (record.running !== terminal.running) record.changedAt = this.deps.now()
    record.running = terminal.running
  }

  lifecycle(paneId: string): void {
    this.record(paneId).changedAt = this.deps.now()
  }

  since(paneId: string): number | undefined {
    return this.panes.get(paneId)?.changedAt
  }

  report(paneId: string, state: string, message: string | undefined, stop: string | undefined) {
    if (state !== 'done') return
    const record = this.record(paneId)
    const explicit = closingLine(message)
    if (explicit) record.explicit = explicit
    if (stop) record.stop = stop.slice(0, STATUS_MESSAGE_MAX)
    if (explicit || stop) this.push(paneId, { kind: 'closing' })
  }

  mail(paneId: string): void {
    this.push(paneId, { kind: 'mail' })
  }

  closing(paneId: string): string | undefined {
    const record = this.panes.get(paneId)
    return record?.explicit ?? record?.stop
  }

  stateOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.state
  }

  stateSince(paneId: string): number | undefined {
    return this.panes.get(paneId)?.stateAt
  }

  changes(
    caller: string,
    paneId: string,
  ): { first: true } | { first: false; events: StampedEvent[] } {
    const key = `${caller}>${paneId}`
    const seen = this.cursors.get(key)
    this.cursors.delete(key)
    this.cursors.set(key, this.seq)
    if (this.cursors.size > JOURNAL_CURSORS_MAX) {
      this.cursors.delete(this.cursors.keys().next().value as string)
    }
    if (seen === undefined) return { first: true }
    return {
      first: false,
      events: (this.panes.get(paneId)?.ring ?? []).filter((e) => e.seq > seen),
    }
  }

  forget(paneId: string, externalId?: string): void {
    this.panes.delete(paneId)
    for (const key of [...this.cursors.keys()]) {
      if (key.endsWith(`>${paneId}`) || (externalId && key.startsWith(`${externalId}>`))) {
        this.cursors.delete(key)
      }
    }
  }
}
