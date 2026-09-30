import { DEFAULT_CHORDS, bindableIds } from '../lib/chords'
import { monaco } from '../monaco/setup'

const font = (title: string) => ({
  type: 'object',
  title,
  additionalProperties: false,
  properties: {
    family: { type: 'string', description: 'Font family name.' },
    size: { type: 'number', minimum: 8, maximum: 32, description: 'Font size in px.' },
    weight: {
      type: 'number',
      enum: [300, 400, 450, 500, 600, 700],
      description: 'Regular text weight (bold text stays bold).',
    },
  },
})

const CHORD_VALUE = {
  type: ['string', 'null'],
  description:
    'A chord like "Ctrl+Shift+K", "Cmd+Alt+P" or "Mod+Shift+K" (Mod is Cmd on macOS, Ctrl ' +
    'elsewhere), or null to unbind. Chords the shell needs are ignored: plain Ctrl+letter, ' +
    'plain or Ctrl arrows, Escape, Tab and keys without Ctrl/Cmd.',
}

export function keybindingsSchema(ids: readonly string[]) {
  return {
    type: 'object',
    description:
      'Keyboard shortcuts: command id → chord, or null to unbind. Unlisted commands keep ' +
      'their default. Edit them in Settings → Keyboard.',
    properties: Object.fromEntries(ids.map((id) => [id, CHORD_VALUE])),
    additionalProperties: CHORD_VALUE,
  }
}

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
            'Theme id (built-in: adeberry, one-dark-vivid, instrument-night, dracula, oxocarbon, pine-light; ' +
            'or a plugin theme). Default: adeberry.',
        },
        followSystem: {
          type: 'boolean',
          description:
            'Switch between lightTheme and darkTheme when the operating system switches. When ' +
            'off, "theme" is used. Default: false.',
        },
        lightTheme: {
          type: 'string',
          description:
            'Theme id used when the OS is light and followSystem is on. Default: pine-light.',
        },
        darkTheme: {
          type: 'string',
          description:
            'Theme id used when the OS is dark and followSystem is on. Default: adeberry.',
        },
        accent: {
          type: 'string',
          pattern: '^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}))?$',
          description:
            'Hex color (#rgb or #rrggbb) that replaces the theme’s brand color. Empty uses the ' +
            'theme’s own. Default: empty.',
        },
        zoom: {
          type: 'integer',
          minimum: 80,
          maximum: 150,
          description: 'Interface zoom in percent. Default: 100.',
        },
        motion: {
          type: 'string',
          enum: ['system', 'reduced', 'full'],
          description:
            'Interface animation. "system" follows the OS reduce-motion preference, "reduced" ' +
            'turns movement off (state stays visible), "full" animates regardless of the OS. ' +
            'Default: system.',
        },
        ui: font('UI font'),
        terminal: {
          ...font('Terminal font'),
          properties: {
            ...font('Terminal font').properties,
            lineHeight: {
              type: 'number',
              minimum: 1,
              maximum: 2,
              description: 'Terminal row height as a multiple of the font size. Default: 1.15.',
            },
          },
        },
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
        inputMode: {
          type: 'string',
          enum: ['terminal', 'editor'],
          description:
            'How you type commands. "terminal" types straight into the shell. "editor" docks ' +
            'an input editor under the command blocks while the shell waits at a prompt ' +
            '(multi-line, history on Up, path completion on Tab); running programs still get ' +
            'your keys directly. Shells without integration always use "terminal". ' +
            'Default: terminal.',
        },
        copyOnSelect: {
          type: 'boolean',
          description: 'Copy selected terminal text to the clipboard as soon as it is selected.',
        },
        gpuAcceleration: {
          type: 'boolean',
          description:
            'Draw terminals on the GPU (WebGL). Block and box-drawing characters then fill ' +
            'their cells exactly. Falls back to the DOM renderer when WebGL is unavailable. ' +
            'Applies to new terminals.',
        },
        restoreWorkspace: {
          type: 'boolean',
          description:
            'Reopen the previous run’s workspaces, panes and terminal scrollback at launch. ' +
            'Shells are always respawned fresh; this restores the workspace’s shape and ' +
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
    notifications: {
      type: 'object',
      additionalProperties: false,
      properties: {
        desktop: { type: 'boolean', description: 'Show system notification banners.' },
        sound: { type: 'boolean', description: 'Play the system sound with each banner.' },
        whenFocused: {
          type: 'boolean',
          description: 'Also show banners for the pane you are looking at while Pine is focused.',
        },
        agentWaiting: {
          type: 'boolean',
          description:
            'Banner when an agent waits for your input or permission (pine state waiting).',
        },
        agentDone: {
          type: 'boolean',
          description: 'Banner when an agent finishes its turn (pine state done).',
        },
        command: {
          type: 'string',
          description:
            'Program run for every notification, e.g. "notify-send {title} {body}". Placeholders: ' +
            '{title}, {body}, {pane}. Runs the program directly, never through a shell. Empty ' +
            'turns it off. Only the human can change it, in Settings.',
        },
        commandFinished: {
          type: 'boolean',
          description: 'Banner when a long command finishes in a pane you are not watching.',
        },
      },
    },
    sidebar: {
      type: 'object',
      additionalProperties: false,
      properties: {
        showPath: { type: 'boolean', description: 'Show each workspace folder under its name.' },
        showMessage: {
          type: 'boolean',
          description: 'Show the latest notification or running command under each workspace.',
        },
        showDescription: {
          type: 'boolean',
          description: 'Show custom workspace descriptions.',
        },
        showExtensionItems: {
          type: 'boolean',
          description: 'Show items extensions add to a workspace row (git branch, counts).',
        },
      },
    },
    workspaces: {
      type: 'object',
      additionalProperties: false,
      properties: {
        placement: {
          type: 'string',
          enum: ['end', 'top', 'afterCurrent'],
          description:
            'Where a new workspace appears in the sidebar: "end" of the list, at the "top" ' +
            '(below pinned workspaces), or right "afterCurrent". Default: end.',
        },
        inheritFolder: {
          type: 'boolean',
          description:
            'Start a new workspace in the folder of the current workspace’s focused pane. ' +
            'Falls back to defaultFolder. Default: false.',
        },
        defaultFolder: {
          type: 'string',
          description: 'Folder a new workspace starts in. "~" is your home folder. Default: ~.',
        },
        confirmClose: {
          type: 'boolean',
          description: 'Ask before closing a workspace that has a running command. Default: true.',
        },
        confirmQuit: {
          type: 'boolean',
          description:
            'Ask before quitting or closing the window while commands are running. Default: true.',
        },
        wrapTitles: {
          type: 'boolean',
          description: 'Wrap long workspace titles onto up to two lines in the sidebar.',
        },
      },
    },
    browser: {
      type: 'object',
      additionalProperties: false,
      properties: {
        searchEngine: {
          type: 'string',
          enum: ['google', 'duckduckgo', 'bing', 'kagi', 'custom'],
          description:
            'Search engine for address-bar text that is not a URL. "custom" uses customSearchUrl. ' +
            'Default: google.',
        },
        customSearchUrl: {
          type: 'string',
          description:
            'Search URL for the "custom" engine: http or https, containing {query}, e.g. ' +
            '"https://example.com/search?q={query}". An invalid template falls back to Google.',
        },
        openTerminalLinks: {
          type: 'boolean',
          description:
            'Ctrl/Cmd+click on a web link in a terminal opens it in Pine’s browser pane instead of ' +
            'the system browser. Default: false.',
        },
        defaultZoom: {
          type: 'number',
          minimum: 50,
          maximum: 300,
          description: 'Page zoom in percent for browser panes when a page loads. Default: 100.',
        },
      },
    },
    editor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        wordWrap: { type: 'string', enum: ['off', 'on'], description: 'Wrap long lines.' },
        lineNumbers: {
          type: 'string',
          enum: ['on', 'off', 'relative'],
          description: 'Line number gutter. "relative" counts lines from the cursor.',
        },
        tabSize: { type: 'number', enum: [2, 4, 8], description: 'Spaces per tab stop.' },
        insertSpaces: {
          type: 'boolean',
          description: 'Insert spaces when Tab is pressed instead of a tab character.',
        },
        autoSave: {
          type: 'string',
          enum: ['off', 'afterDelay', 'onFocusChange'],
          description:
            'Save changed files by themselves: "afterDelay" one second after the last edit, ' +
            '"onFocusChange" when the editor loses focus. Default: off.',
        },
        formatOnSave: {
          type: 'boolean',
          description:
            'Format the document before every save with the language server or built-in ' +
            'formatter. Files with no formatter are just saved. Default: false.',
        },
      },
    },
    keybindings: keybindingsSchema(Object.keys(DEFAULT_CHORDS)),
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
              'all-workspaces',
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
            'cover the rest). Human-edited only; restart Pine to apply.',
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
    schemas: [
      {
        uri: 'pine://settings-schema',
        fileMatch: [uri],
        schema: {
          ...SETTINGS_JSON_SCHEMA,
          properties: {
            ...SETTINGS_JSON_SCHEMA.properties,
            keybindings: keybindingsSchema(bindableIds()),
          },
        },
      },
    ],
  })
}
