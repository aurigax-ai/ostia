import { monaco } from '../monaco/setup'

const font = (title: string) => ({
  type: 'object',
  title,
  additionalProperties: false,
  properties: {
    family: { type: 'string', description: 'Font family name.' },
    size: { type: 'number', minimum: 8, maximum: 32, description: 'Font size in px.' },
  },
})

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
            'Theme id (built-in: adeberry, one-dark-vivid, instrument-night, dracula, oxocarbon; ' +
            'or a plugin theme). Default: adeberry.',
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
        restoreSession: {
          type: 'boolean',
          description:
            'Reopen the previous run’s sessions, panes and terminal scrollback at launch. ' +
            'Shells are always respawned fresh — this restores the workspace’s shape and ' +
            'history, not live processes. Turning it off erases what is already stored.',
        },
        externalEditor: {
          type: 'string',
          description:
            'Command for "Open in External Editor". "auto" picks the first of code, cursor, zed ' +
            'on PATH; empty turns it off. Placeholders: {file}, {line}, {column}, e.g. ' +
            '"code -g {file}:{line}:{column}". Runs the program directly, never through a shell.',
        },
      },
    },
    sync: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: {
          type: 'string',
          description:
            'Folder to sync settings and extension choices through (a git repository, ' +
            'Syncthing or Dropbox folder). Empty turns sync off. Set it from Settings → Sync; ' +
            'agents cannot change it. Secrets and capability grants never sync.',
        },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        grants: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'send-other-pane',
              'kill-pane',
              'workspace-wide',
              'shell',
              'destructive',
              'phone',
              'gateway',
              'browse',
              'settings-write',
            ],
          },
          description:
            'Elevated capabilities pre-granted to every pane (pane-scoped defaults already ' +
            'cover the rest). Human-edited only — restart Pine to apply.',
        },
      },
    },
  },
}

export async function registerSettingsSchema(): Promise<void> {
  const path = await window.pine.settings.path()
  const uri = monaco.Uri.file(path).toString()
  const json = monaco.languages.json as unknown as {
    jsonDefaults: { setDiagnosticsOptions: (options: unknown) => void }
  }
  json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemas: [{ uri: 'pine://settings-schema', fileMatch: [uri], schema: SETTINGS_JSON_SCHEMA }],
  })
}
