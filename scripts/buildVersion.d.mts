export interface GitState {
  tags: string[]
  commit: string
  dirty: boolean
}

export function buildVersion(base: string, git: GitState | null): string

export function telemetryStamp(
  env: Record<string, string | undefined>,
): { key: string; host: string } | null
