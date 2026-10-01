export const PLUGINS_NAV_EXPANDED_KEY = 'settingsNav.pluginsExpanded'
export const PLUGINS_SECTION = 'plugins'

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
  return { section: head, extension: head === PLUGINS_SECTION && tail ? tail : (extension ?? null) }
}

export function extensionAnchorId(extId: string): string {
  return `settings-extension-${extId}`
}

export function pluginsNavExpanded(): boolean {
  try {
    return window.localStorage.getItem(PLUGINS_NAV_EXPANDED_KEY) === 'true'
  } catch {
    return false
  }
}

export function rememberPluginsNavExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(PLUGINS_NAV_EXPANDED_KEY, String(expanded))
  } catch {}
}
