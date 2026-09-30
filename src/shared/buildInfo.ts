export interface BuildInfo {
  version: string
  commit: string | null
  builtAt: string
}

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, commit, builtAt } = raw as Record<string, unknown>
  if (typeof version !== 'string' || typeof builtAt !== 'string') return null
  return { version, commit: typeof commit === 'string' ? commit : null, builtAt }
}

export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.version === b.version && a.commit === b.commit && a.builtAt === b.builtAt
}

export function buildLabel(info: BuildInfo): string {
  return info.commit ? `${info.version} (${info.commit})` : info.version
}
