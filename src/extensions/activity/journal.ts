import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_DIR, ARCHIVE_MAX_BYTES, Archive, storableWorkspaceId } from './archive'
import {
  type ActivityNote,
  type ActivityRecord,
  isOpenNeedsYou,
  parseStoredRecord,
} from './hookEvent'

export const JOURNAL_DIR = 'journal'
export const HOST_DIR = 'host'
const JOURNAL_SUFFIX = '.jsonl'
const JOURNAL_MAX_BYTES = 512 * 1024
export const DAY_MS = 24 * 60 * 60 * 1000
export const RETENTION_DAYS = 14
export const ARCHIVE_DAYS = 180
const JOURNAL_FILE_MODE = 0o600
const JOURNAL_DIR_MODE = 0o700

const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
const REWRITE_FLAGS =
  constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | constants.O_NOFOLLOW

interface WorkspaceJournal {
  events: ActivityRecord[]
  bytes: number
  onDisk: boolean
}

export interface Retention {
  liveMs: number
  archiveMs: number
}

export interface JournalOptions {
  dir: string | null
  now: () => number
  maxBytes?: number
  archiveMaxBytes?: number
  retention?: Retention
}

function lineOf(event: ActivityRecord): string {
  return `${JSON.stringify(event)}\n`
}

function bytesOf(events: readonly ActivityRecord[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(lineOf(event)), 0)
}

export class Journal {
  private readonly byWorkspace = new Map<string, WorkspaceJournal>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private readonly dir: string | null
  private readonly archive: Archive | null
  private readonly now: () => number
  private readonly maxBytes: number
  private readonly archiveMaxBytes: number
  private retention: Retention

  constructor(options: JournalOptions) {
    this.dir = options.dir ? join(options.dir, JOURNAL_DIR) : null
    this.archive = options.dir ? new Archive(join(options.dir, ARCHIVE_DIR)) : null
    this.now = options.now
    this.maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES
    this.archiveMaxBytes = options.archiveMaxBytes ?? ARCHIVE_MAX_BYTES
    this.retention = options.retention ?? {
      liveMs: RETENTION_DAYS * DAY_MS,
      archiveMs: ARCHIVE_DAYS * DAY_MS,
    }
  }

  setRetention(retention: Retention): void {
    this.retention = retention
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
      const { kept: events, old } = this.split(stored.events)
      this.archive?.add(workspaceId, old)
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

  append(workspaceId: string, event: ActivityRecord, persist: boolean): void {
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
    this.touch(workspaceId)
  }

  revision(workspaceId: string): number {
    return this.revisions.get(workspaceId) ?? 0
  }

  events(workspaceId: string): readonly ActivityRecord[] {
    return this.byWorkspace.get(workspaceId)?.events ?? []
  }

  archived(workspaceId: string): ActivityRecord[] {
    return this.archive && storableWorkspaceId(workspaceId) ? this.archive.records(workspaceId) : []
  }

  find(workspaceId: string, id: string): ActivityRecord | null {
    return (
      this.events(workspaceId).find((record) => record.id === id) ??
      this.archived(workspaceId).find((record) => record.id === id) ??
      null
    )
  }

  openNeedsYou(workspaceId: string): ActivityNote[] {
    return this.events(workspaceId).filter(isOpenNeedsYou) as ActivityNote[]
  }

  markDone(workspaceId: string, id: string, at: number): ActivityNote | null {
    const journal = this.byWorkspace.get(workspaceId)
    const index = journal?.events.findIndex((record) => record.id === id) ?? -1
    const found = journal?.events[index]
    if (!journal || !found || found.kind !== 'note' || !found.needsYou) return null
    if (found.doneAt !== undefined) return found
    const done: ActivityNote = { ...found, doneAt: at }
    journal.events = journal.events.map((record, i) => (i === index ? done : record))
    journal.bytes = bytesOf(journal.events)
    if (journal.onDisk) this.rewrite(workspaceId, journal)
    this.touch(workspaceId)
    return done
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
      this.touch(workspaceId)
      dropped = true
    }
    return dropped
  }

  prune(): boolean {
    let changed = false
    this.archive?.prune(this.now(), {
      maxAgeMs: this.retention.archiveMs,
      maxBytes: this.archiveMaxBytes,
    })
    for (const [workspaceId, journal] of this.byWorkspace) {
      const { kept: events, old } = this.split(journal.events)
      if (old.length === 0) continue
      if (journal.onDisk) this.archive?.add(workspaceId, old)
      changed = true
      this.touch(workspaceId)
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

  private touch(workspaceId: string): void {
    this.revisions.set(workspaceId, ++this.sequence)
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

  private split(events: readonly ActivityRecord[]): {
    kept: ActivityRecord[]
    old: ActivityRecord[]
  } {
    const oldest = this.now() - this.retention.liveMs
    const kept: ActivityRecord[] = []
    const old: ActivityRecord[] = []
    for (const event of events) {
      if (event.t >= oldest || isOpenNeedsYou(event)) kept.push(event)
      else old.push(event)
    }
    return { kept, old }
  }

  private trim(workspaceId: string, journal: WorkspaceJournal): void {
    if (journal.bytes <= this.maxBytes) return
    const target = Math.floor(this.maxBytes / 2)
    let bytes = journal.bytes
    const moved = new Set<ActivityRecord>()
    for (const event of journal.events.slice(0, -1)) {
      if (bytes <= target) break
      if (isOpenNeedsYou(event)) continue
      moved.add(event)
      bytes -= Buffer.byteLength(lineOf(event))
    }
    if (moved.size === 0) return
    if (journal.onDisk) this.archive?.add(workspaceId, [...moved])
    journal.events = journal.events.filter((event) => !moved.has(event))
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

  private readFile(workspaceId: string): { events: ActivityRecord[]; dirty: boolean } | null {
    let fd: number
    try {
      fd = openSync(this.file(workspaceId), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return null
    }
    try {
      const events: ActivityRecord[] = []
      let dirty = false
      for (const line of readFileSync(fd, 'utf8').split('\n')) {
        if (line === '') continue
        let event: ActivityRecord | null = null
        try {
          event = parseStoredRecord(JSON.parse(line))
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
