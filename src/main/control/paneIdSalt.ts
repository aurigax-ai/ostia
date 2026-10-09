import { randomBytes } from 'node:crypto'
import { loadJson, saveJson } from '../platform/jsonStore'

interface SaltFile {
  salt?: unknown
}

const SALT_BYTES = 32

export function loadPaneIdSalt(path: string): Buffer {
  const stored = loadJson<SaltFile>(path, {}).salt
  if (typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, 'hex')
  const salt = randomBytes(SALT_BYTES)
  try {
    saveJson(path, { salt: salt.toString('hex') }, { secure: true })
  } catch (err) {
    console.error('[pane-ids] could not save the pane id salt; ids will change on restart', err)
  }
  return salt
}
