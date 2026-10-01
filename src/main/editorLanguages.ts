import { resolve } from 'node:path'
import { ipcMain } from 'electron'
import {
  type EditorLanguage,
  type EditorLanguageContribution,
  GRAMMAR_FILE_MAX_BYTES,
  type MonarchGrammar,
  validateMonarchGrammar,
} from '../shared/editorLanguages'
import { readConfined } from './iconThemes'

export interface EditorLanguageSource {
  extId: string
  dir: string
  language: EditorLanguageContribution
}

export interface EditorLanguageDeps {
  languages: () => EditorLanguageSource[]
  onError: (extId: string, error: string) => void
}

export type GrammarResult = { ok: true; grammar: MonarchGrammar } | { ok: false; error: string }

export function readGrammar(dir: string, path: string): GrammarResult {
  const file = readConfined(dir, resolve(dir, path), GRAMMAR_FILE_MAX_BYTES)
  if (!file.ok) return file
  let raw: unknown
  try {
    raw = JSON.parse(file.data.toString('utf8'))
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  const grammar = validateMonarchGrammar(raw)
  return typeof grammar === 'string' ? { ok: false, error: grammar } : { ok: true, grammar }
}

export function loadEditorLanguages(deps: EditorLanguageDeps): EditorLanguage[] {
  const loaded: EditorLanguage[] = []
  for (const { extId, dir, language } of deps.languages()) {
    if (loaded.some((other) => other.id === language.id)) {
      deps.onError(extId, `editor language '${language.id}' is already provided`)
      continue
    }
    const res = readGrammar(dir, language.grammar)
    if (!res.ok) {
      deps.onError(extId, `${language.grammar}: ${res.error}`)
      continue
    }
    loaded.push({
      extId,
      id: language.id,
      name: language.name,
      extensions: language.extensions,
      filenames: language.filenames,
      configuration: language.configuration,
      grammar: res.grammar,
    })
  }
  return loaded
}

export function registerEditorLanguageIpc(deps: EditorLanguageDeps): void {
  ipcMain.handle('editorLanguages:load', () => loadEditorLanguages(deps))
}
