import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appEnv } from '../../shared/appEnv'
import type { SecretEntry, SecretGrant } from '../../shared/sandbox/secrets'

export interface PreparedSecrets {
  env: Record<string, string>
  missing: string[]
  sshKeys: string[]
}

export interface PrepareSecretsInput {
  grants: readonly SecretGrant[]
  list: readonly SecretEntry[]
  value: (id: string) => string | null
  dir: string
}

export function envName(name: string): string {
  const upper = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return /^[0-9]/.test(upper) ? `_${upper}` : upper
}

function fileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function prepareSecrets(input: PrepareSecretsInput): PreparedSecrets {
  const env: Record<string, string> = {}
  const missing: string[] = []
  const sshKeys: string[] = []
  const fileGrants = input.grants.filter((g) => g.mode === 'file')
  if (fileGrants.length > 0) {
    rmSync(input.dir, { recursive: true, force: true })
    mkdirSync(input.dir, { recursive: true, mode: 0o700 })
    Object.assign(env, appEnv({ SECRETS_DIR: input.dir }))
  }
  for (const grant of input.grants) {
    if (grant.mode === 'request') continue
    const entry = input.list.find((s) => s.id === grant.id)
    const label = entry?.name ?? grant.id.split(':').pop() ?? grant.id
    const value = entry ? input.value(entry.id) : null
    if (value === null) {
      missing.push(label)
      continue
    }
    if (grant.mode === 'env') {
      env[grant.name ?? envName(label)] = value
      continue
    }
    const path = join(input.dir, fileName(grant.name ?? label))
    writeFileSync(path, value, { mode: 0o600 })
    if (entry?.kind === 'ssh-key') sshKeys.push(path)
  }
  return { env, missing, sshKeys }
}
