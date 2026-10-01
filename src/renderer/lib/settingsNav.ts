export const EXTENSIONS_NAV_EXPANDED_KEY = 'settingsNav.extensionsExpanded'
export const SANDBOX_NAV_EXPANDED_KEY = 'settingsNav.sandboxExpanded'
export const EXTENSIONS_SECTION = 'extensions'

export interface SettingsTarget {
  section: string | null
  extension: string | null
}

export function parseSettingsTarget(section?: string, extension?: string): SettingsTarget {
  if (!section) return { section: null, extension: null }
  const slash = section.indexOf('/')
  if (slash < 0) return { section, extension: extension ?? null }
  const head = section.slice(0, slash)
  const tail = section.slice(slash + 1)
  return {
    section: head,
    extension: head === EXTENSIONS_SECTION && tail ? tail : (extension ?? null),
  }
}

export function extensionAnchorId(extId: string): string {
  return `settings-extension-${extId}`
}

export function navExpanded(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

export function rememberNavExpanded(key: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(key, String(expanded))
  } catch {}
}
