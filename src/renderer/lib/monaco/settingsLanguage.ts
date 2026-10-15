import type * as Monaco from 'monaco-editor'
import { setupMode } from 'monaco-editor/languages/features/json/jsonMode.js'
import { SETTINGS_LANGUAGE_ID } from './language'

const ALL_FEATURES = {
  documentFormattingEdits: true,
  documentRangeFormattingEdits: true,
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  tokens: true,
  colors: true,
  foldingRanges: true,
  diagnostics: true,
  selectionRanges: true,
}

type Listener = (defaults: SettingsJsonDefaults) => void

class SettingsJsonDefaults {
  private readonly listeners = new Set<Listener>()
  readonly languageId = SETTINGS_LANGUAGE_ID
  readonly modeConfiguration = ALL_FEATURES
  diagnosticsOptions: unknown = { validate: true, allowComments: false, schemas: [] }

  readonly onDidChange = (listener: Listener): { dispose: () => void } => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  setDiagnosticsOptions(options: unknown): void {
    this.diagnosticsOptions = options
    for (const listener of [...this.listeners]) listener(this)
  }
}

export const settingsJsonDefaults = new SettingsJsonDefaults()

export function registerSettingsLanguage(monaco: typeof Monaco): void {
  monaco.languages.register({ id: SETTINGS_LANGUAGE_ID, aliases: ['JSON'] })
  setupMode(settingsJsonDefaults)
}
