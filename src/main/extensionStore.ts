import { ALL_CAPABILITIES, type Capability } from '../shared/capabilities'
import { loadJson, saveJson } from './jsonStore'

export interface ExtensionRecord {
  enabled: boolean
  approved: Capability[] | null
}

export type ExtensionRecords = Record<string, ExtensionRecord>

export function grantedCaps(
  requested: readonly Capability[],
  approved: readonly Capability[] | null,
): Capability[] {
  if (!approved) return []
  return requested.filter((cap) => approved.includes(cap))
}

export function effectiveRecord(
  builtin: boolean,
  record: ExtensionRecord | undefined,
): ExtensionRecord {
  if (record) return record
  return builtin
    ? { enabled: true, approved: [...ALL_CAPABILITIES] }
    : { enabled: false, approved: null }
}

export function needsApproval(builtin: boolean, record: ExtensionRecord | undefined): boolean {
  return !builtin && (record === undefined || record.approved === null)
}

function sanitize(raw: unknown): ExtensionRecords {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: ExtensionRecords = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const v = value as { enabled?: unknown; approved?: unknown }
    const approved = Array.isArray(v.approved)
      ? v.approved.filter((c): c is Capability => ALL_CAPABILITIES.includes(c as Capability))
      : null
    Object.defineProperty(out, id, {
      value: { enabled: v.enabled === true, approved },
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export class ExtensionStore {
  private records: ExtensionRecords

  constructor(private readonly path: string) {
    this.records = sanitize(loadJson<unknown>(path, {}))
  }

  get(id: string): ExtensionRecord | undefined {
    return Object.hasOwn(this.records, id) ? this.records[id] : undefined
  }

  reload(): void {
    this.records = sanitize(loadJson<unknown>(this.path, {}))
  }

  set(id: string, record: ExtensionRecord): void {
    this.records = { ...this.records, [id]: record }
    saveJson(this.path, this.records)
  }

  delete(id: string): void {
    if (!Object.hasOwn(this.records, id)) return
    const { [id]: _removed, ...rest } = this.records
    this.records = rest
    saveJson(this.path, this.records)
  }
}
