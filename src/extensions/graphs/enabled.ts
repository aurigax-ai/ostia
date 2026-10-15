import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { ScheduleMemory } from '@aurigax-ai/wire'

export const ENABLED_FILE = 'enabled.json'
const CHANGED_FILE = 'changed.json'

function changedFile(enabled: string): string {
  return join(dirname(enabled), CHANGED_FILE)
}

export interface EnabledRecord {
  workspaceId: string
  realPath: string
  fingerprint: string
  at: number
}

interface Stored {
  enabled: EnabledRecord[]
  changed: { workspaceId: string; realPath: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(raw: unknown): Stored {
  if (!isRecord(raw)) return { enabled: [], changed: [] }
  const enabled = Array.isArray(raw.enabled)
    ? raw.enabled.filter(
        (r): r is EnabledRecord =>
          isRecord(r) &&
          typeof r.workspaceId === 'string' &&
          typeof r.realPath === 'string' &&
          typeof r.fingerprint === 'string' &&
          typeof r.at === 'number',
      )
    : []
  const changed = Array.isArray(raw.changed)
    ? raw.changed.filter(
        (r): r is Stored['changed'][number] =>
          isRecord(r) && typeof r.workspaceId === 'string' && typeof r.realPath === 'string',
      )
    : []
  return { enabled, changed }
}

function writeDataFile(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

export function scheduleMemory(path: string | null): ScheduleMemory {
  let marks: Record<string, number> = {}
  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') marks[k] = v
      }
    } catch {}
  }
  return {
    last: (key) => marks[key],
    mark: (key, at) => {
      marks = { ...marks, [key]: at }
      if (path) writeDataFile(path, marks)
    },
  }
}

export class EnableStore {
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  private memory: Stored = { enabled: [], changed: [] }

  private readFile(file: string): unknown {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  private load(): Stored {
    if (!this.file) return this.memory
    const enabled = parse(this.readFile(this.file)).enabled
    const changed = parse(this.readFile(changedFile(this.file))).changed
    return { enabled, changed }
  }

  private save(stored: Stored): void {
    if (!this.file) {
      this.memory = stored
      return
    }
    writeDataFile(this.file, { enabled: stored.enabled })
    writeDataFile(changedFile(this.file), { changed: stored.changed })
  }

  record(workspaceId: string, realPath: string): EnabledRecord | null {
    return (
      this.load().enabled.find((r) => r.workspaceId === workspaceId && r.realPath === realPath) ??
      null
    )
  }

  wasChanged(workspaceId: string, realPath: string): boolean {
    return this.load().changed.some((r) => r.workspaceId === workspaceId && r.realPath === realPath)
  }

  enable(workspaceId: string, realPath: string, fingerprint: string): EnabledRecord {
    const stored = this.load()
    const record = { workspaceId, realPath, fingerprint, at: this.now() }
    const same = (r: { workspaceId: string; realPath: string }) =>
      r.workspaceId === workspaceId && r.realPath === realPath
    this.save({
      enabled: [...stored.enabled.filter((r) => !same(r)), record],
      changed: stored.changed.filter((r) => !same(r)),
    })
    return record
  }

  disable(workspaceId: string, realPath: string, changed = false): void {
    const stored = this.load()
    const same = (r: { workspaceId: string; realPath: string }) =>
      r.workspaceId === workspaceId && r.realPath === realPath
    if (!stored.enabled.some(same) && !changed) return
    this.save({
      enabled: stored.enabled.filter((r) => !same(r)),
      changed: changed
        ? [...stored.changed.filter((r) => !same(r)), { workspaceId, realPath }]
        : stored.changed.filter((r) => !same(r)),
    })
  }

  checked(
    workspaceId: string,
    realPath: string,
    fingerprint: string,
  ): 'enabled' | 'changed' | 'not-enabled' {
    const record = this.record(workspaceId, realPath)
    if (record?.fingerprint === fingerprint) return 'enabled'
    if (record) {
      this.disable(workspaceId, realPath, true)
      return 'changed'
    }
    return this.wasChanged(workspaceId, realPath) ? 'changed' : 'not-enabled'
  }
}
