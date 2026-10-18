import { readFileSync } from 'node:fs'
import { type EnvSource, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'

export function paneToken(env: EnvSource = process.env): string | undefined {
  const token = readEnv('TOKEN', env)
  if (token) return token
  const file = readEnv('TOKEN_FILE', env)
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
