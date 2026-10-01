import {
  type EditorLanguageMapping,
  SETTINGS_LANGUAGE_ID,
  languageForPath,
} from '@shared/editorLanguages'

export { SETTINGS_LANGUAGE_ID }

let settingsFile: string | null = null
let contributed: readonly EditorLanguageMapping[] = []

export function setSettingsFile(path: string | null): void {
  settingsFile = path
}

export function setContributedLanguages(languages: readonly EditorLanguageMapping[]): void {
  contributed = languages
}

export function fileLanguage(path: string): string {
  return languageForPath(path, contributed)
}

export function langFor(path: string): string {
  return path === settingsFile ? SETTINGS_LANGUAGE_ID : fileLanguage(path)
}
