import { appLinkScheme } from '../common/externalLinks'

const ALLOWED_APP_SCHEMES_MAX = 100

export function parseAllowedAppSchemes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || out.length >= ALLOWED_APP_SCHEMES_MAX) continue
    const scheme = item.toLowerCase()
    if (appLinkScheme(`${scheme}://x`) === scheme && !out.includes(scheme)) out.push(scheme)
  }
  return out
}

export function parseAskBeforeOpeningApps(raw: unknown): boolean {
  return raw !== false
}

export function appLinkAsks(
  settings: { askBeforeOpeningApps: boolean; allowedAppSchemes: readonly string[] },
  scheme: string,
): boolean {
  return settings.askBeforeOpeningApps && !settings.allowedAppSchemes.includes(scheme)
}
