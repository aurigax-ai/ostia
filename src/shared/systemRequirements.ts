export interface MissingRequirement {
  program: string
  package: string
  needs?: string
}

export type RequirementCheck = { ok: true } | { ok: false; missing: MissingRequirement[] }

export interface InstallHint {
  command: string | null
  packages: string[]
}

export interface RequirementsReport {
  missing: MissingRequirement[]
  hint: InstallHint
  canInstall: boolean
}
