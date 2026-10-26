export interface GitState {
  tags: string[]
  commit: string
  dirty: boolean
}

export function nextPatch(base: string): string

export function buildVersion(
  base: string,
  git: GitState | null,
  mainRun?: string | null,
  localInstall?: boolean,
): string

export function isLocalInstall(env: Record<string, string | undefined>): boolean

export function mainBuildRun(env: Record<string, string | undefined>): string | null

export function telemetryStamp(
  env: Record<string, string | undefined>,
): { key: string; host: string } | null
