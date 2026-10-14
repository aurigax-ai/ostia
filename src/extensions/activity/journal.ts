import {
  constants,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { type ActivityEvent, parseStoredEvent } from './hookEvent'

export const JOURNAL_DIR = 'journal'
const JOURNAL_SUFFIX = '.jsonl'
const JOURNAL_MAX_BYTES = 512 * 1024
export const JOURNAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const JOURNAL_FILE_MODE = 0o600
const JOURNAL_DIR_MODE = 0o700

const WORKSPACE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
const REWRITE_FLAGS =
  constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | constants.O_NOFOLLOW

interface WorkspaceJournal {
  events: ActivityEvent[]
  bytes: number
  onDisk: boolean
}

export interface JournalOptions {
  dir: string | null
  now: () => number
  maxBytes?: number
  maxAgeMs?: number
}

function lineOf(event: ActivityEvent): string {
  return `${JSON.stringify(event)}\n`
}

function bytesOf(events: readonly ActivityEvent[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(lineOf(event)), 0)
}

function storableWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_FILE_PATTERN.test(workspaceId)
}

export class Journal {
  private readonly byWorkspace = new Map<string, WorkspaceJournal>()
  private readonly dir: string | null
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly maxAgeMs: number

  constructor(options: JournalOptions) {
    this.dir = options.dir ? join(options.dir, JOURNAL_DIR) : null
    this.now = options.now
    this.maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES
    this.maxAgeMs = options.maxAgeMs ?? JOURNAL_MAX_AGE_MS
  }

  load(): void {
    if (!this.dir) return
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const workspaceId = name.endsWith(JOURNAL_SUFFIX) ? name.slice(0, -JOURNAL_SUFFIX.length) : ''
      if (!storableWorkspaceId(workspaceId)) continue
      const stored = this.readFile(workspaceId)
      if (!stored) continue
      const events = this.fresh(stored.events)
      if (events.length === 0) {
        this.removeFile(workspaceId)
        continue
      }
      const journal = { events, bytes: bytesOf(events), onDisk: true }
      this.byWorkspace.set(workspaceId, journal)
      if (stored.dirty || events.length !== stored.events.length) this.rewrite(workspaceId, journal)
      this.trim(workspaceId, journal)
    }
  }

  append(workspaceId: string, event: ActivityEvent, persist: boolean): void {
    const journal = this.byWorkspace.get(workspaceId) ?? this.create(workspaceId, persist)
    if (journal.onDisk && !persist) {
      journal.onDisk = false
      this.removeFile(workspaceId)
    }
    const line = lineOf(event)
    journal.events.push(event)
    journal.bytes += Buffer.byteLength(line)
    if (journal.onDisk && !this.appendLine(workspaceId, line)) journal.onDisk = false
    this.trim(workspaceId, journal)
  }

  events(workspaceId: string): readonly ActivityEvent[] {
    return this.byWorkspace.get(workspaceId)?.events ?? []
  }

  workspaceIds(): string[] {
    return [...this.byWorkspace.keys()]
  }

  keepsOnDisk(workspaceId: string): boolean {
    return this.byWorkspace.get(workspaceId)?.onDisk === true
  }

  dropClosedMemory(open: ReadonlySet<string>): boolean {
    let dropped = false
    for (const [workspaceId, journal] of this.byWorkspace) {
      if (journal.onDisk || open.has(workspaceId)) continue
      this.byWorkspace.delete(workspaceId)
      dropped = true
    }
    return dropped
  }

  prune(): boolean {
    let changed = false
    for (const [workspaceId, journal] of this.byWorkspace) {
      const events = this.fresh(journal.events)
      if (events.length === journal.events.length) continue
      changed = true
      if (events.length === 0) {
        this.byWorkspace.delete(workspaceId)
        if (journal.onDisk) this.removeFile(workspaceId)
        continue
      }
      journal.events = events
      journal.bytes = bytesOf(events)
      if (journal.onDisk) this.rewrite(workspaceId, journal)
    }
    return changed
  }

  private create(workspaceId: string, persist: boolean): WorkspaceJournal {
    const journal = {
      events: [],
      bytes: 0,
      onDisk: persist && this.dir !== null && storableWorkspaceId(workspaceId),
    }
    this.byWorkspace.set(workspaceId, journal)
    return journal
  }

  private fresh(events: readonly ActivityEvent[]): ActivityEvent[] {
    const oldest = this.now() - this.maxAgeMs
    return events.filter((event) => event.t >= oldest)
  }

  private trim(workspaceId: string, journal: WorkspaceJournal): void {
    if (journal.bytes <= this.maxBytes) return
    const target = Math.floor(this.maxBytes / 2)
    let bytes = journal.bytes
    let first = 0
    while (first < journal.events.length - 1 && bytes > target) {
      bytes -= Buffer.byteLength(lineOf(journal.events[first]))
      first += 1
    }
    journal.events = journal.events.slice(first)
    journal.bytes = bytes
    if (journal.onDisk) this.rewrite(workspaceId, journal)
  }

  private file(workspaceId: string): string {
    return join(this.dir ?? '', `${workspaceId}${JOURNAL_SUFFIX}`)
  }

  private ensureDir(): void {
    if (!this.dir) return
    mkdirSync(this.dir, { recursive: true, mode: JOURNAL_DIR_MODE })
    chmodSync(this.dir, JOURNAL_DIR_MODE)
  }

  private readFile(workspaceId: string): { events: ActivityEvent[]; dirty: boolean } | null {
    let fd: number
    try {
      fd = openSync(this.file(workspaceId), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return null
    }
    try {
      const events: ActivityEvent[] = []
      let dirty = false
      for (const line of readFileSync(fd, 'utf8').split('\n')) {
        if (line === '') continue
        let event: ActivityEvent | null = null
        try {
          event = parseStoredEvent(JSON.parse(line))
        } catch {}
        if (event) events.push(event)
        else dirty = true
      }
      return { events, dirty }
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }

  private appendLine(workspaceId: string, line: string): boolean {
    try {
      this.ensureDir()
      const fd = openSync(this.file(workspaceId), APPEND_FLAGS, JOURNAL_FILE_MODE)
      try {
        writeSync(fd, line)
      } finally {
        closeSync(fd)
      }
      return true
    } catch {
      return false
    }
  }

  private rewrite(workspaceId: string, journal: WorkspaceJournal): void {
    const file = this.file(workspaceId)
    const staging = `${file}.tmp`
    try {
      this.ensureDir()
      rmSync(staging, { force: true })
      const fd = openSync(staging, REWRITE_FLAGS | constants.O_EXCL, JOURNAL_FILE_MODE)
      try {
        writeSync(fd, journal.events.map(lineOf).join(''))
      } finally {
        closeSync(fd)
      }
      renameSync(staging, file)
    } catch {
      journal.onDisk = false
      this.removeFile(workspaceId)
    }
  }

  private removeFile(workspaceId: string): void {
    if (!this.dir || !storableWorkspaceId(workspaceId)) return
    try {
      rmSync(this.file(workspaceId), { force: true })
    } catch {}
  }
}
