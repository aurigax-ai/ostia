import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseManagerSettings } from '../../shared/agents/managerSettings'

export interface SettingsFile {
  locale?: unknown
  extensionSettings?: unknown
  git?: unknown
  ports?: unknown
  workspaces?: { globalHotkey?: unknown; confirmQuit?: unknown }
  manager?: unknown
  assistant?: unknown
  agent?: unknown
  playbooks?: unknown
  privacy?: unknown
  terminal?: {
    shell?: unknown
    keepShells?: unknown
    scrollbackHistory?: unknown
    askBeforeOpeningApps?: unknown
    allowedAppSchemes?: unknown
  }
  agents?: {
    hooks?: unknown
    trustWorkspaceFolders?: unknown
    finishedHibernateMinutes?: unknown
  }
  behavior?: { historySuggestions?: unknown }
}

export function readSettingsFileOrNull(): { assistant?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    )
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
}

export function readSettingsFile(): SettingsFile {
  try {
    return JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

export function readLocale(): string | undefined {
  const locale = readSettingsFile().locale
  return typeof locale === 'string' ? locale : undefined
}

export function managerSettings() {
  return parseManagerSettings(readSettingsFile().manager)
}
