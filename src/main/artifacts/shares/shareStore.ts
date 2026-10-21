import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { ShareMode } from '../../../shared/artifacts/shares'

export interface ShareRecord {
  id: string
  mode: ShareMode
  source: string
  name: string
  size: number
  url: string
  deleteToken: string
  linkKey: string | null
  origin: string
  accountId: string
  createdAt: number
  expiresAt: number
}

export interface ShareStoreDeps {
  load: () => unknown
  save: (data: { records: Record<string, string> }) => void
  canEncrypt: () => boolean
  encrypt: (plain: string) => string
  decrypt: (secret: string) => string
}

const MODES: readonly string[] = ['link', 'password', 'public']

function parseRecord(value: unknown): ShareRecord | null {
  if (!isRecord(value)) return null
  const {
    id,
    mode,
    source,
    name,
    size,
    url,
    deleteToken,
    linkKey,
    origin,
    accountId,
    createdAt,
    expiresAt,
  } = value
  if (
    typeof id !== 'string' ||
    typeof mode !== 'string' ||
    !MODES.includes(mode) ||
    typeof source !== 'string' ||
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    typeof url !== 'string' ||
    typeof deleteToken !== 'string' ||
    (linkKey !== null && typeof linkKey !== 'string') ||
    typeof origin !== 'string' ||
    typeof accountId !== 'string' ||
    typeof createdAt !== 'number' ||
    typeof expiresAt !== 'number'
  ) {
    return null
  }
  return {
    id,
    mode: mode as ShareMode,
    source,
    name,
    size,
    url,
    deleteToken,
    linkKey,
    origin,
    accountId,
    createdAt,
    expiresAt,
  }
}

export class ShareStore {
  constructor(private readonly deps: ShareStoreDeps) {}

  available(): boolean {
    return this.deps.canEncrypt()
  }

  private sealed(): Record<string, string> {
    const stored = this.deps.load()
    if (!isRecord(stored) || !isRecord(stored.records)) return {}
    return Object.fromEntries(
      Object.entries(stored.records).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }

  list(): ShareRecord[] {
    if (!this.available()) return []
    const out: ShareRecord[] = []
    for (const secret of Object.values(this.sealed())) {
      try {
        const record = parseRecord(JSON.parse(this.deps.decrypt(secret)))
        if (record) out.push(record)
      } catch {}
    }
    return out
  }

  get(id: string): ShareRecord | null {
    return this.list().find((record) => record.id === id) ?? null
  }

  add(record: ShareRecord): boolean {
    if (!this.available()) return false
    this.deps.save({
      records: { ...this.sealed(), [record.id]: this.deps.encrypt(JSON.stringify(record)) },
    })
    return true
  }

  remove(id: string): void {
    const { [id]: _gone, ...rest } = this.sealed()
    this.deps.save({ records: rest })
  }
}
