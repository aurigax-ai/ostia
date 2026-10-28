import type { EditorLanguage } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'

let fetched: readonly EditorLanguage[] = []

export function setFetchedEditorLanguages(languages: readonly EditorLanguage[]): void {
  fetched = languages
}

export function fetchedEditorLanguages(): readonly EditorLanguage[] {
  return fetched
}
