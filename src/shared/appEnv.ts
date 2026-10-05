export const ENV_PREFIX = 'OSTIA_'

export type EnvSource = Record<string, string | undefined>

export function envName(name: string): string {
  return `${ENV_PREFIX}${name}`
}

export function readEnv(name: string, env: EnvSource = process.env): string | undefined {
  return env[envName(name)] || undefined
}

export function appEnv(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [envName(name), value]))
}

export function withoutEnv(env: EnvSource, names: readonly string[]): EnvSource {
  const drop = new Set(names.map(envName))
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key)))
}

export function isAppEnvName(key: string): boolean {
  return key.startsWith(ENV_PREFIX)
}

export function shellEnv(name: string): string {
  return `\${${envName(name)}}`
}
