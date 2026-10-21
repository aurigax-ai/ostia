import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { type DeviceKeys, keysFromSeeds, seedsOf } from './deviceKeys'

export interface KeyStoreDeps {
  load: () => unknown
  save: (data: Record<string, string> | null) => void
  canEncrypt: () => boolean
  encrypt: (plain: string) => string
  decrypt: (secret: string) => string
}

export interface KeyStore {
  available: () => boolean
  load: () => DeviceKeys | null
  save: (keys: DeviceKeys) => boolean
  erase: () => void
}

export function createKeyStore(deps: KeyStoreDeps): KeyStore {
  return {
    available: () => deps.canEncrypt(),
    load: () => {
      const stored = deps.load()
      if (!isRecord(stored) || !deps.canEncrypt()) return null
      const { sign, box } = stored
      if (typeof sign !== 'string' || typeof box !== 'string') return null
      try {
        return keysFromSeeds({
          sign: Buffer.from(deps.decrypt(sign), 'base64url'),
          box: Buffer.from(deps.decrypt(box), 'base64url'),
        })
      } catch {
        return null
      }
    },
    save: (keys) => {
      if (!deps.canEncrypt()) return false
      const seeds = seedsOf(keys)
      deps.save({
        sign: deps.encrypt(seeds.sign.toString('base64url')),
        box: deps.encrypt(seeds.box.toString('base64url')),
      })
      return true
    },
    erase: () => deps.save(null),
  }
}
