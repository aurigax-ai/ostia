import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'

export const CONSENT_FILE = 'helper-hosts.json'
export const CONSENT_HOSTS_MAX = 500
const HOST_KEY_PATTERN = /^[A-Za-z0-9._@:-]{1,330}$/
const VERSION_PATTERN = /^[0-9a-f]{12}$/

type HelperAnswer = 'allowed' | 'refused'

export interface HostRecord {
  answer: HelperAnswer
  version?: string
  installed?: true
  at: string
}

function hostRecord(raw: unknown): HostRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { answer, version, installed, at } = raw as Record<string, unknown>
  if (answer !== 'allowed' && answer !== 'refused') return null
  const record: HostRecord = { answer, at: typeof at === 'string' ? at.slice(0, 40) : '' }
  if (typeof version === 'string' && VERSION_PATTERN.test(version)) record.version = version
  if (answer === 'allowed' && record.version && installed === true) record.installed = true
  return record
}

export function parseConsent(text: string): Map<string, HostRecord> {
  const hosts = new Map<string, HostRecord>()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return hosts
  }
  const listed = (raw as { hosts?: unknown } | null)?.hosts
  if (typeof listed !== 'object' || listed === null || Array.isArray(listed)) return hosts
  for (const [key, value] of Object.entries(listed)) {
    if (hosts.size >= CONSENT_HOSTS_MAX) break
    const record = HOST_KEY_PATTERN.test(key) ? hostRecord(value) : null
    if (record) hosts.set(key, record)
  }
  return hosts
}

export class HelperConsent {
  private readonly hosts: Map<string, HostRecord>

  constructor(private readonly file: string | null) {
    this.hosts = file ? parseConsent(this.read(file)) : new Map()
  }

  private read(file: string): string {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(
      this.file,
      `${JSON.stringify({ hosts: Object.fromEntries(this.hosts) }, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
  }

  get(key: string): HostRecord | undefined {
    return this.hosts.get(key)
  }

  all(): [string, HostRecord][] {
    return [...this.hosts.entries()]
  }

  set(key: string, record: HostRecord): void {
    if (!HOST_KEY_PATTERN.test(key)) return
    if (!this.hosts.has(key) && this.hosts.size >= CONSENT_HOSTS_MAX) {
      const oldest = this.hosts.keys().next().value
      if (oldest !== undefined) this.hosts.delete(oldest)
    }
    this.hosts.set(key, record)
    this.save()
  }

  forget(key: string): void {
    if (this.hosts.delete(key)) this.save()
  }
}
