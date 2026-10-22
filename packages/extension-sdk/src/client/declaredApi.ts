import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '../contract/appEnv'
import { EXTENSION_MANIFEST_FILE } from '../contract/extensions'
import { isRecord } from '../contract/isRecord'

export function declaredApi(): string {
  const dir = readEnv('EXTENSION_DIR')
  if (!dir) throw new Error('OSTIA_EXTENSION_DIR missing')
  const file = join(dir, EXTENSION_MANIFEST_FILE)
  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const api = isRecord(manifest) ? manifest.api : undefined
  if (typeof api !== 'string') throw new Error(`${file} declares no api`)
  return api
}
