import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { Protect } from '../secrets'
import { KEY_BYTES, type ManifestDevice } from './syncCrypto'

export interface SyncKeyFile {
  load: () => unknown
  save: (data: StoredSyncKeys) => void
}

interface SeenDevice {
  signPub: string
  boxPub: string
  createdAt: number
  at: number
  changed: boolean
}

interface StoredSyncKeys {
  keys: Record<string, string>
  counters: Record<string, number>
  pinned: Record<string, ManifestDevice[]>
  seen: Record<string, Record<string, SeenDevice>>
  gc: Record<string, number>
  announced: Record<string, string[]>
}

export interface SyncKeyStore {
  key: (account: string) => Buffer | null
  setKey: (account: string, key: Buffer) => boolean
  forgetKey: (account: string) => void
  highest: (account: string) => number
  raise: (account: string, counter: number) => void
  pinned: (account: string) => ManifestDevice[]
  pin: (account: string, devices: ManifestDevice[], now: number) => void
  firstSeen: (account: string, device: ManifestDevice) => number | null
  lastGc: (account: string) => number
  announced: (account: string) => string[]
  setAnnounced: (account: string, ids: string[]) => void
  setLastGc: (account: string, at: number) => void
  changedSince: (account: string, since: number) => { id: string; name: string; at: number }[]
}

function deviceOf(value: unknown): ManifestDevice | null {
  if (!isRecord(value)) return null
  const { id, name, signPub, boxPub, createdAt } = value
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof signPub !== 'string' ||
    typeof boxPub !== 'string' ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt)
  ) {
    return null
  }
  return { id, name, signPub, boxPub, createdAt }
}

function devicesOf(value: unknown): ManifestDevice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((v) => {
    const device = deviceOf(v)
    return device ? [device] : []
  })
}

function read(file: SyncKeyFile): StoredSyncKeys {
  const raw = file.load()
  const out: StoredSyncKeys = {
    keys: {},
    counters: {},
    pinned: {},
    seen: {},
    gc: {},
    announced: {},
  }
  if (!isRecord(raw)) return out
  if (isRecord(raw.keys)) {
    for (const [id, value] of Object.entries(raw.keys)) {
      if (typeof value === 'string') out.keys[id] = value
    }
  }
  if (isRecord(raw.counters)) {
    for (const [id, value] of Object.entries(raw.counters)) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        out.counters[id] = value
      }
    }
  }
  if (isRecord(raw.pinned)) {
    for (const [id, value] of Object.entries(raw.pinned)) out.pinned[id] = devicesOf(value)
  }
  if (isRecord(raw.announced)) {
    for (const [id, value] of Object.entries(raw.announced)) {
      if (Array.isArray(value)) {
        out.announced[id] = value.filter((entry): entry is string => typeof entry === 'string')
      }
    }
  }
  if (isRecord(raw.gc)) {
    for (const [id, value] of Object.entries(raw.gc)) {
      if (typeof value === 'number' && Number.isFinite(value)) out.gc[id] = value
    }
  }
  if (isRecord(raw.seen)) {
    for (const [account, byId] of Object.entries(raw.seen)) {
      if (!isRecord(byId)) continue
      out.seen[account] = {}
      for (const [id, value] of Object.entries(byId)) {
        const entry = seenOf(value)
        if (entry) out.seen[account][id] = entry
      }
    }
  }
  return out
}

function seenOf(value: unknown): SeenDevice | null {
  const device = deviceOf(isRecord(value) ? { id: '', name: '', ...value } : null)
  return device && isRecord(value) && typeof value.at === 'number' && Number.isFinite(value.at)
    ? {
        signPub: device.signPub,
        boxPub: device.boxPub,
        createdAt: device.createdAt,
        at: value.at,
        changed: value.changed === true,
      }
    : null
}

const sameEntry = (seen: SeenDevice | undefined, d: ManifestDevice): boolean =>
  seen !== undefined &&
  seen.signPub === d.signPub &&
  seen.boxPub === d.boxPub &&
  seen.createdAt === d.createdAt

function markSeen(data: StoredSyncKeys, account: string, devices: ManifestDevice[], now: number) {
  const byId = data.seen[account] ?? {}
  for (const d of devices) {
    if (sameEntry(byId[d.id], d)) continue
    byId[d.id] = {
      signPub: d.signPub,
      boxPub: d.boxPub,
      createdAt: d.createdAt,
      at: now,
      changed: d.id in byId,
    }
  }
  data.seen[account] = byId
}

export function createSyncKeyStore(file: SyncKeyFile, protect: Protect): SyncKeyStore {
  return {
    key: (account) => {
      const kept = read(file).keys[account]
      if (kept === undefined) return null
      try {
        const key = Buffer.from(protect.decrypt(kept), 'base64url')
        return key.length === KEY_BYTES ? key : null
      } catch {
        return null
      }
    },
    setKey: (account, key) => {
      try {
        const data = read(file)
        data.keys[account] = protect.encrypt(key.toString('base64url'))
        file.save(data)
        return true
      } catch {
        return false
      }
    },
    forgetKey: (account) => {
      const data = read(file)
      if (!(account in data.keys)) return
      delete data.keys[account]
      file.save(data)
    },
    highest: (account) => read(file).counters[account] ?? 0,
    raise: (account, counter) => {
      const data = read(file)
      if (counter <= (data.counters[account] ?? 0)) return
      data.counters[account] = counter
      file.save(data)
    },
    pinned: (account) => read(file).pinned[account] ?? [],
    firstSeen: (account, device) => {
      const seen = read(file).seen[account]?.[device.id]
      return sameEntry(seen, device) ? (seen?.at ?? null) : null
    },
    announced: (account) => read(file).announced[account] ?? [],
    setAnnounced: (account, ids) => {
      const data = read(file)
      data.announced[account] = ids
      file.save(data)
    },
    lastGc: (account) => read(file).gc[account] ?? 0,
    setLastGc: (account, at) => {
      const data = read(file)
      data.gc[account] = at
      file.save(data)
    },
    changedSince: (account, since) => {
      const data = read(file)
      const seen = data.seen[account] ?? {}
      return (data.pinned[account] ?? []).flatMap((d) => {
        const entry = seen[d.id]
        return sameEntry(entry, d) && entry?.changed && entry.at > since
          ? [{ id: d.id, name: d.name, at: entry.at }]
          : []
      })
    },
    pin: (account, devices, now) => {
      const data = read(file)
      markSeen(data, account, devices, now)
      data.pinned[account] = devices
      file.save(data)
    },
  }
}
