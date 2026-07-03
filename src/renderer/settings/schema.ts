import { monaco } from '../monaco/setup'

/** A monospace font sub-schema (family + clamped size). */
const font = (title: string) => ({
  type: 'object',
  title,
  additionalProperties: false,
  properties: {
    family: { type: 'string', description: 'Font family name.' },
    size: { type: 'number', minimum: 8, maximum: 32, description: 'Font size in px.' },
  },
})

/**
 * JSON Schema for settings.json — the single source of truth for the file's shape. It
 * validates the file and powers IntelliSense when the user opens it in the editor.
 */
export const SETTINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Pine Settings',
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: {
      type: 'string',
      enum: ['en', 'zh-Hant'],
      description: 'Interface language.',
    },
    appearance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: {
          type: 'string',
          description:
            'Theme id (built-in: one-dark-vivid, instrument-night, dracula, oxocarbon; or a plugin theme).',
        },
        ui: font('UI font'),
        terminal: font('Terminal font'),
        editor: font('Editor font'),
      },
    },
    behavior: {
      type: 'object',
      additionalProperties: false,
      properties: {
        showHiddenFiles: {
          type: 'boolean',
          description: 'Show dotfiles (names starting with .) in the Files explorer.',
        },
        cursorStyle: {
          type: 'string',
          enum: ['block', 'underline', 'bar'],
          description: 'Terminal cursor shape.',
        },
        cursorBlink: { type: 'boolean', description: 'Blink the terminal cursor.' },
      },
    },
  },
}

/**
 * Register the schema with Monaco's JSON language service, matched to settings.json, so
 * opening it in an editor pane gives live validation + completion. Call once at startup.
 */
export async function registerSettingsSchema(): Promise<void> {
  const path = await window.pine.settings.path()
  const uri = monaco.Uri.file(path).toString()
  // The ESM build types `languages.json` as a deprecated stub, but the contribution we
  // bundle populates `jsonDefaults` at runtime.
  const json = monaco.languages.json as unknown as {
    jsonDefaults: { setDiagnosticsOptions: (options: unknown) => void }
  }
  json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [{ uri: 'pine://settings-schema', fileMatch: [uri], schema: SETTINGS_JSON_SCHEMA }],
  })
}
