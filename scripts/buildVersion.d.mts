export interface GitState {
  tags: string[]
  commit: string
  dirty: boolean
}

export function buildVersion(base: string, git: GitState | null): string
