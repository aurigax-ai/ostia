import { languageForPath } from '@shared/editorLanguages'

export const SETTINGS_LANGUAGE_ID = 'pine-settings'

let settingsFile: string | null = null

export function setSettingsFile(path: string | null): void {
  settingsFile = path
}

export function langFor(path: string): string {
  return path === settingsFile ? SETTINGS_LANGUAGE_ID : languageForPath(path)
}
