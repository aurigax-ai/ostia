import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { Protect } from '../secrets'
import { KEY_BYTES } from './syncCrypto'

export interface SyncKeyFile {
  load: () => unknown
  save: (data: StoredSyncKeys) => void
}

interface StoredSyncKeys {
  keys: Record<string, string>
  counters: Record<string, number>
  gc: Record<string, number>
}

export interface SyncKeyStore {
  key: (account: string) => Buffer | null
  setKey: (account: string, key: Buffer) => boolean
  forgetKey: (account: string) => void
  highest: (account: string) => number
  raise: (account: string, counter: number) => void
  lastGc: (account: string) => number
  setLastGc: (account: string, at: number) => void
}

function numbersOf(value: unknown, valid: (n: number) => boolean): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(value)) return out
  for (const [id, n] of Object.entries(value)) {
    if (typeof n === 'number' && valid(n)) out[id] = n
  }
  return out
}

function read(file: SyncKeyFile): StoredSyncKeys {
  const raw = file.load()
  const out: StoredSyncKeys = { keys: {}, counters: {}, gc: {} }
  if (!isRecord(raw)) return out
  if (isRecord(raw.keys)) {
    for (const [id, value] of Object.entries(raw.keys)) {
      if (typeof value === 'string') out.keys[id] = value
    }
  }
  out.counters = numbersOf(raw.counters, (n) => Number.isSafeInteger(n) && n >= 0)
  out.gc = numbersOf(raw.gc, Number.isFinite)
  return out
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
    lastGc: (account) => read(file).gc[account] ?? 0,
    setLastGc: (account, at) => {
      const data = read(file)
      data.gc[account] = at
      file.save(data)
    },
  }
}
