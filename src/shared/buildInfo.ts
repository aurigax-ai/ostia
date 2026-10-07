export interface BuildInfo {
  version: string
  builtAt: string
}

export function releaseVersion(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : version.slice(0, plus)
}

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, builtAt } = raw as Record<string, unknown>
  if (typeof version !== 'string' || typeof builtAt !== 'string') return null
  return { version, builtAt }
}

export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.version === b.version && a.builtAt === b.builtAt
}
