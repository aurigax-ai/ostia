export const ENV_PREFIX = 'OSTIA_'
export const LEGACY_ENV_PREFIX = 'PINE_'

export type EnvSource = Record<string, string | undefined>

export function envName(name: string): string {
  return `${ENV_PREFIX}${name}`
}

export function legacyEnvName(name: string): string {
  return `${LEGACY_ENV_PREFIX}${name}`
}

export function readEnv(name: string, env: EnvSource = process.env): string | undefined {
  return env[envName(name)] || env[legacyEnvName(name)] || undefined
}

export function dualEnv(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    out[envName(name)] = value
    out[legacyEnvName(name)] = value
  }
  return out
}

export function withoutEnv(env: EnvSource, names: readonly string[]): EnvSource {
  const drop = new Set(names.flatMap((name) => [envName(name), legacyEnvName(name)]))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key)))
}

export function isAppEnvName(key: string): boolean {
  return key.startsWith(ENV_PREFIX) || key.startsWith(LEGACY_ENV_PREFIX)
}

export function shellEnv(name: string): string {
  return `\${${envName(name)}:-$${legacyEnvName(name)}}`
}
