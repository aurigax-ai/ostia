import {
  ALL_CAPABILITIES,
  BUILTIN_CAPABILITIES,
  type Capability,
} from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { type FileKindInfo, kindClaim } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { loadJson, saveJson } from '../platform/jsonStore'

export interface ExtensionRecord {
  enabled: boolean
  approved: Capability[] | null
  approvedKinds?: string[]
  serversOff?: string[]
}

const MAX_SERVERS_OFF = 64
const MAX_APPROVED_KINDS = 64
const MAX_CLAIM_LENGTH = 2048

export type ExtensionRecords = Record<string, ExtensionRecord>

export function grantedCaps(
  requested: readonly Capability[],
  approved: readonly Capability[] | null,
): Capability[] {
  if (!approved) return []
  return requested.filter((cap) => approved.includes(cap))
}

export function kindApproved(
  builtin: boolean,
  record: ExtensionRecord | undefined,
  kind: Pick<FileKindInfo, 'id' | 'selector'>,
): boolean {
  return builtin || (record?.approvedKinds ?? []).includes(kindClaim(kind))
}

export function effectiveRecord(
  builtin: boolean,
  record: ExtensionRecord | undefined,
): ExtensionRecord {
  if (record) return record
  return builtin
    ? { enabled: true, approved: [...BUILTIN_CAPABILITIES] }
    : { enabled: false, approved: null }
}

export function needsApproval(builtin: boolean, record: ExtensionRecord | undefined): boolean {
  return !builtin && (record === undefined || record.approved === null)
}

function sanitize(raw: unknown): ExtensionRecords {
  if (!isRecord(raw)) return {}
  const out: ExtensionRecords = {}
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    const v = value as {
      enabled?: unknown
      approved?: unknown
      approvedKinds?: unknown
      serversOff?: unknown
    }
    const approved = Array.isArray(v.approved)
      ? v.approved.filter((c): c is Capability => ALL_CAPABILITIES.includes(c as Capability))
      : null
    const approvedKinds = Array.isArray(v.approvedKinds)
      ? v.approvedKinds
          .filter((c): c is string => typeof c === 'string' && c.length <= MAX_CLAIM_LENGTH)
          .slice(0, MAX_APPROVED_KINDS)
      : []
    const serversOff = Array.isArray(v.serversOff)
      ? v.serversOff
          .filter((s): s is string => typeof s === 'string' && s.length <= 40)
          .slice(0, MAX_SERVERS_OFF)
      : []
    Object.defineProperty(out, id, {
      value: {
        enabled: v.enabled === true,
        approved,
        ...(approvedKinds.length > 0 ? { approvedKinds } : {}),
        ...(serversOff.length > 0 ? { serversOff } : {}),
      },
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
