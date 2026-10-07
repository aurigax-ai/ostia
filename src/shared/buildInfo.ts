export interface TelemetryStamp {
  key: string
  host: string
}

export interface BuildInfo {
  version: string
  builtAt: string
  telemetry?: TelemetryStamp
}

export function releaseVersion(version: string): string {
  const plus = version.indexOf('+')
  return plus === -1 ? version : version.slice(0, plus)
}

export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, builtAt, telemetry } = raw as Record<string, unknown>
  if (typeof version !== 'string' || typeof builtAt !== 'string') return null
  const stamp = parseTelemetryStamp(telemetry)
  return { version, builtAt, ...(stamp ? { telemetry: stamp } : {}) }
}

export function parseTelemetryStamp(raw: unknown): TelemetryStamp | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { key, host } = raw as Record<string, unknown>
  if (typeof key !== 'string' || key === '' || typeof host !== 'string' || host === '') return null
  return { key, host }
}

export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.version === b.version && a.builtAt === b.builtAt
}
