import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { CredentialStore } from '../browser/credentials'
import { type SecretStoreDeps, sanitizeSecrets } from '../extensions/extensionSecrets'
import type { SecretEntry, SecretSource, SecretSourceName } from './secrets'

function mtimeOr(mtime: () => number): number {
  try {
    return mtime()
  } catch {
    return 0
  }
}

export function groupedSource(
  name: Exclude<SecretSourceName, 'vault' | 'logins'>,
  store: SecretStoreDeps,
  mtime: () => number,
): SecretSource {
  return {
    name,
    read: () => {
      const out = new Map<string, SecretEntry>()
      if (!store.canEncrypt()) return out
      const at = mtimeOr(mtime)
      for (const [group, values] of Object.entries(sanitizeSecrets(store.load()))) {
        for (const [key, kept] of Object.entries(values)) {
          try {
            out.set(JSON.stringify([group, key]), { value: store.decrypt(kept), at })
          } catch {}
        }
      }
      return out
    },
    write: (changes) => {
      const data = sanitizeSecrets(store.load())
      for (const [id, value] of changes) {
        const [group, key] = JSON.parse(id) as [string, string]
        const values = { ...(data[group] ?? {}) }
        if (value === null) delete values[key]
        else values[key] = store.encrypt(value)
        if (Object.keys(values).length === 0) delete data[group]
        else data[group] = values
      }
      store.save({ ...data })
    },
    describe: (id) => (JSON.parse(id) as [string, string]).join(': '),
  }
}

export function flatSource(store: SecretStoreDeps, mtime: () => number): SecretSource {
  const load = (): Record<string, string> => {
    const raw = store.load()
    if (!isRecord(raw)) return {}
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  }
  return {
    name: 'vault',
    read: () => {
      const out = new Map<string, SecretEntry>()
      if (!store.canEncrypt()) return out
      const at = mtimeOr(mtime)
      for (const [key, kept] of Object.entries(load())) {
        try {
          out.set(key, { value: store.decrypt(kept), at })
        } catch {}
      }
      return out
    },
    write: (changes) => {
      const data = load()
      for (const [key, value] of changes) {
        if (value === null) delete data[key]
        else data[key] = store.encrypt(value)
      }
      store.save(data as never)
    },
    describe: (key) => key,
  }
}

export function loginsSource(store: CredentialStore): SecretSource {
  return {
    name: 'logins',
    read: () => {
      const out = new Map<string, SecretEntry>()
      for (const login of store.list()) {
        const password = store.password(login.id)
        if (password === null) continue
        out.set(JSON.stringify([login.origin, login.username]), {
          value: password,
          at: login.updatedAt,
        })
      }
      return out
    },
    write: (changes) => {
      const byKey = new Map(
        store.list().map((login) => [JSON.stringify([login.origin, login.username]), login.id]),
      )
      for (const [key, value] of changes) {
        const [origin, username] = JSON.parse(key) as [string, string]
        if (value === null) {
          const id = byKey.get(key)
          if (id) store.remove(id)
        } else store.save({ origin, username, password: value })
      }
    },
    describe: (key) => {
      const [origin, username] = JSON.parse(key) as [string, string]
      return `${origin} (${username})`
    },
  }
}
