import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { type ActivityRecord, parseStoredRecord } from './hookEvent'

export const ARCHIVE_DIR = 'archive'
const MONTH_SUFFIX = '.jsonl.gz'
const MONTH_PATTERN = /^\d{4}-\d{2}$/
const WORKSPACE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024
const ARCHIVE_FILE_MODE = 0o600
const ARCHIVE_DIR_MODE = 0o700
const APPEND_FLAGS =
  constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW

export interface ArchiveLimits {
  maxAgeMs: number
  maxBytes: number
}

export function storableWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_FILE_PATTERN.test(workspaceId)
}

function monthOf(t: number): string {
  return new Date(t).toISOString().slice(0, 7)
}

function monthEnd(month: string): number {
  const [year, index] = month.split('-').map(Number)
  return Date.UTC(year, index, 1)
}

export class Archive {
  constructor(private readonly dir: string) {}

  add(workspaceId: string, records: readonly ActivityRecord[]): boolean {
    const byMonth = new Map<string, string>()
    for (const record of records) {
      const month = monthOf(record.t)
      byMonth.set(month, `${byMonth.get(month) ?? ''}${JSON.stringify(record)}\n`)
    }
    try {
      this.ensureDir(workspaceId)
      for (const [month, lines] of byMonth) {
        const fd = openSync(this.file(workspaceId, month), APPEND_FLAGS, ARCHIVE_FILE_MODE)
        try {
          writeSync(fd, gzipSync(lines))
        } finally {
          closeSync(fd)
        }
      }
      return true
    } catch {
      return false
    }
  }

  records(workspaceId: string): ActivityRecord[] {
    const out: ActivityRecord[] = []
    for (const month of this.months(workspaceId)) {
      for (const line of this.read(workspaceId, month).split('\n')) {
        if (line === '') continue
        let record: ActivityRecord | null = null
        try {
          record = parseStoredRecord(JSON.parse(line))
        } catch {}
        if (record) out.push(record)
      }
    }
    return out
  }

  prune(now: number, limits: ArchiveLimits): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const workspaceId of names.filter(storableWorkspaceId)) {
      const months = this.months(workspaceId)
      const kept: { month: string; bytes: number }[] = []
      for (const month of months) {
        if (monthEnd(month) < now - limits.maxAgeMs) this.remove(workspaceId, month)
        else kept.push({ month, bytes: this.size(workspaceId, month) })
      }
      let bytes = kept.reduce((sum, m) => sum + m.bytes, 0)
      while (bytes > limits.maxBytes && kept.length > 0) {
        const oldest = kept.shift() as { month: string; bytes: number }
        this.remove(workspaceId, oldest.month)
        bytes -= oldest.bytes
      }
      if (kept.length === 0) rmSync(join(this.dir, workspaceId), { recursive: true, force: true })
    }
  }

  private months(workspaceId: string): string[] {
    try {
      const dir = join(this.dir, workspaceId)
      if (!lstatSync(dir).isDirectory()) return []
      return readdirSync(dir)
        .filter((name) => name.endsWith(MONTH_SUFFIX))
        .map((name) => name.slice(0, -MONTH_SUFFIX.length))
        .filter((month) => MONTH_PATTERN.test(month))
        .sort()
    } catch {
      return []
    }
  }

  private read(workspaceId: string, month: string): string {
    let fd: number
    try {
      fd = openSync(this.file(workspaceId, month), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return ''
    }
    try {
      return gunzipSync(readFileSync(fd)).toString('utf8')
    } catch {
      return ''
    } finally {
      closeSync(fd)
    }
  }

  private size(workspaceId: string, month: string): number {
    try {
      return lstatSync(this.file(workspaceId, month)).size
    } catch {
      return 0
    }
  }

  private remove(workspaceId: string, month: string): void {
    rmSync(this.file(workspaceId, month), { force: true })
  }

  private file(workspaceId: string, month: string): string {
    return join(this.dir, workspaceId, `${month}${MONTH_SUFFIX}`)
  }

  private ensureDir(workspaceId: string): void {
    for (const dir of [this.dir, join(this.dir, workspaceId)]) {
      mkdirSync(dir, { recursive: true, mode: ARCHIVE_DIR_MODE })
      chmodSync(dir, ARCHIVE_DIR_MODE)
    }
  }
}
