import type { LanguageServerInfo } from '@shared/languageServers'

export interface BuiltinDefaults {
  readonly modeConfiguration: Record<string, boolean | undefined>
  setModeConfiguration: (configuration: Record<string, boolean | undefined>) => void
}

export type BuiltinDefaultsByLanguage = Record<string, BuiltinDefaults | undefined>

const KEPT_FEATURES: ReadonlySet<string> = new Set(['tokens'])

export function claimedLanguages(servers: readonly LanguageServerInfo[]): Set<string> {
  const claimed = new Set<string>()
  for (const server of servers) {
    if (!server.enabled || (server.status !== 'running' && server.status !== 'idle')) continue
    for (const language of server.languages) claimed.add(language)
  }
  return claimed
}

function withoutLanguageFeatures(
  configuration: Record<string, boolean | undefined>,
): Record<string, boolean | undefined> {
  return Object.fromEntries(
    Object.entries(configuration).map(([feature, on]) => [
      feature,
      KEPT_FEATURES.has(feature) ? on : false,
    ]),
  )
}

export class BuiltinFeatures {
  private readonly saved = new Map<string, Record<string, boolean | undefined>>()

  constructor(private readonly defaults: () => BuiltinDefaultsByLanguage) {}

  apply(claimed: ReadonlySet<string>): void {
    for (const [language, defaults] of Object.entries(this.defaults())) {
      if (!defaults) continue
      const saved = this.saved.get(language)
      if (claimed.has(language) && !saved) {
        this.saved.set(language, defaults.modeConfiguration)
        defaults.setModeConfiguration(withoutLanguageFeatures(defaults.modeConfiguration))
      } else if (!claimed.has(language) && saved) {
        this.saved.delete(language)
        defaults.setModeConfiguration(saved)
      }
    }
  }
}
