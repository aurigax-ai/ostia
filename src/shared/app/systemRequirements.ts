export interface MissingRequirement {
  program: string
  package: string
  needs?: string
  found?: string
}

export interface InstallHint {
  command: string | null
  packages: string[]
}

export interface RequirementsReport {
  missing: MissingRequirement[]
  hint: InstallHint
  canInstall: boolean
}
