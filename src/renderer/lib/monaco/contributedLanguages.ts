import type { EditorLanguage, EditorLanguageConfiguration } from '@shared/editorLanguages'
import { setContributedLanguages } from './language'
import { monaco } from './setup'

const registered = new Set<string>()
const providers = new Map<string, monaco.IDisposable[]>()

function languageConfiguration(
  configuration: EditorLanguageConfiguration,
): monaco.languages.LanguageConfiguration {
  const { lineComment, blockComment, brackets, autoClosingPairs } = configuration
  return {
    comments: {
      ...(lineComment ? { lineComment } : {}),
      ...(blockComment ? { blockComment } : {}),
    },
    ...(brackets ? { brackets } : {}),
    ...(autoClosingPairs
      ? { autoClosingPairs: autoClosingPairs.map(([open, close]) => ({ open, close })) }
      : {}),
  }
}

export function applyEditorLanguages(languages: readonly EditorLanguage[]): EditorLanguage[] {
  for (const disposables of providers.values()) {
    for (const disposable of disposables) disposable.dispose()
  }
  providers.clear()
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id))
  const applied: EditorLanguage[] = []
  for (const language of languages) {
    if (known.has(language.id) && !registered.has(language.id)) continue
    try {
      if (!registered.has(language.id)) {
        monaco.languages.register({
          id: language.id,
          aliases: [language.name],
          extensions: language.extensions,
          filenames: language.filenames,
        })
        registered.add(language.id)
      }
      providers.set(language.id, [
        monaco.languages.setLanguageConfiguration(
          language.id,
          languageConfiguration(language.configuration),
        ),
        monaco.languages.setMonarchTokensProvider(
          language.id,
          language.grammar as monaco.languages.IMonarchLanguage,
        ),
      ])
      applied.push(language)
    } catch {
      providers.delete(language.id)
    }
  }
  setContributedLanguages(applied)
  return applied
}

export async function loadEditorLanguages(): Promise<void> {
  applyEditorLanguages(await window.ostia.editorLanguages.load())
}
