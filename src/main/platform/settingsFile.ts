import { chmodSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
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
  agents?: { hooks?: unknown; trustWorkspaceFolders?: unknown }
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

let recoveredCopy: string | null = null

export function recoveredSettingsCopy(): string | null {
  return recoveredCopy
}

export function recoverCorruptSettings(now: () => number = Date.now): void {
  const file = join(app.getPath('userData'), 'settings.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  if (text.trim() === '') return
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return
  } catch {}
  const copy = `${file}.corrupt-${now()}`
  try {
    renameSync(file, copy)
    chmodSync(copy, 0o600)
    writeFileAtomic(file, '{}\n')
  } catch (err) {
    console.error('[settings] could not set a corrupt settings.json aside', err)
    return
  }
  recoveredCopy = copy
}
