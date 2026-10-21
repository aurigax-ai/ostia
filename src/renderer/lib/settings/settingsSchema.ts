import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { DEFAULT_CHORDS } from '@shared/keyboard/defaultChords'
import { REMAP_DEFAULTS, REMAP_KEYS, REMAP_TARGETS } from '@shared/keyboard/modifierRemap'
import { bindableIds } from '@/lib/keyboard/chords'
import { isKeyboardPlatform, keyboardPlatform } from '@/lib/keyboard/keyboardPresets'
import { platform } from '@/platform'
import {
  actionsSchema,
  agentHostSchema,
  agentsSchema,
  approvalsSchema,
  assistantSchema,
  capabilitiesSchema,
  managerSchema,
  playbooksSchema,
  privacySchema,
  trustedActionsSchema,
} from './agentSchema'
import { appearanceSchema, behaviorSchema, schemeChoice } from './appearanceSchema'
import {
  KEYBINDINGS_DESC,
  KEYMAP_VALUE,
  keybindingsSchema,
  perPlatformSchema,
  TERMINAL_KEYMAP_VALUE,
  TERMINAL_KEYS_VALUE,
} from './keyboardSchema'
import { KEYBOARD_FIELDS } from './keyboardSettings'
import { notificationsSchema, panesSchema, terminalSchema } from './terminalSchema'
import {
  filesSchema,
  gitSchema,
  portsSchema,
  sidebarSchema,
  workspaceGroupsSchema,
  workspacesSchema,
} from './workspaceSchema'

export const SETTINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: `${PRODUCT_DISPLAY_NAME} Settings`,
  type: 'object',
  additionalProperties: false,
  properties: {
    locale: {
      type: 'string',
      enum: ['en', 'zh-Hant'],
      description: 'Interface language.',
    },
    appearance: appearanceSchema,
    behavior: behaviorSchema,
    files: filesSchema,
    terminal: terminalSchema,
    panes: panesSchema,
    notifications: notificationsSchema,
    sidebar: sidebarSchema,
    assistant: assistantSchema,
    agent: agentHostSchema,
    agents: agentsSchema,
    workspaces: workspacesSchema,
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
        defaultZoom: {
          type: 'number',
          minimum: 50,
          maximum: 300,
          description: 'Page zoom in percent for browser panes when a page loads. Default: 100.',
        },
        attachCaptureImage: {
          type: 'boolean',
          description:
            'When a browser capture (a picked element or a cropped region) is sent to an agent, insert its screenshot as a second @reference after the report, so agents that attach @image paths see the picture. Default: true.',
        },
      },
    },
    editor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        theme: schemeChoice('editor'),
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
        markdownPreview: {
          type: 'boolean',
          description:
            'Open Markdown files in the rendered preview instead of the source. Default: false.',
        },
        diffLayout: {
          type: 'string',
          enum: ['auto', 'sideBySide', 'inline'],
          description:
            'How a diff shows: "auto" puts both texts side by side and switches to one inline ' +
            'column when the pane is narrow, "sideBySide" and "inline" always use that layout. ' +
            'The buttons in the diff toolbar set it. Default: auto.',
        },
        diffIgnoreWhitespace: {
          type: 'boolean',
          description:
            'Leave out changes that only add or remove whitespace at the ends of lines in a ' +
            'diff. The button in the diff toolbar switches it. Default: false.',
        },
        openFilesIn: {
          type: 'string',
          enum: ['tab', 'split'],
          description:
            'Where an opened file shows: "tab" as a tab next to the focused pane (reusing an ' +
            'editor tab already there), "split" in the workspace editor pane, split to the ' +
            'right when there is none. Default: tab.',
        },
      },
    },
    keymap: perPlatformSchema(
      'The App shortcuts preset for each platform ("mac", "linux"). A platform without one ' +
        'uses its default. Pick it in Settings → Keyboard.',
      KEYMAP_VALUE,
    ),
    terminalKeymap: perPlatformSchema(
      'The text editing preset for each platform ("mac", "linux"): the keys that send line and ' +
        'word editing sequences to the shell. A platform without one uses its default. Pick ' +
        'it in Settings → Keyboard.',
      TERMINAL_KEYMAP_VALUE,
    ),
    keybindings: perPlatformSchema(
      KEYBINDINGS_DESC,
      keybindingsSchema(Object.keys(DEFAULT_CHORDS)),
    ),
    terminalKeys: perPlatformSchema(
      'Your keys that send text to the terminal, for each platform ("mac", "linux"). Only you ' +
        'can change this, in Settings → Keyboard; agents cannot.',
      TERMINAL_KEYS_VALUE,
    ),
    modifierRemap: {
      type: 'object',
      additionalProperties: false,
      description:
        'macOS: what each physical modifier key does inside Ostia. A key not listed keeps its ' +
        'own. Only you can change this, in Settings → Keyboard; agents cannot. Other platforms ' +
        'ignore it.',
      properties: Object.fromEntries(
        REMAP_KEYS.map((key) => [
          key,
          {
            type: 'string',
            enum: [...REMAP_TARGETS],
            description: `Default: ${REMAP_DEFAULTS[key]}.`,
          },
        ]),
      ),
    },
    workspaceGroups: workspaceGroupsSchema,
    git: gitSchema,
    ports: portsSchema,
    extensionSettings: {
      type: 'object',
      description:
        'Extension id → its setting values. Edit them in Settings → Extensions; each ' +
        "extension's manifest lists its settings.",
      additionalProperties: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
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
    actions: actionsSchema,
    privacy: privacySchema,
    playbooks: playbooksSchema,
    manager: managerSchema,
    trustedActions: trustedActionsSchema,
    approvals: approvalsSchema,
    capabilities: capabilitiesSchema,
  },
}

export function fullSettingsSchema() {
  return {
    ...SETTINGS_JSON_SCHEMA,
    properties: {
      ...SETTINGS_JSON_SCHEMA.properties,
      keybindings: perPlatformSchema(KEYBINDINGS_DESC, keybindingsSchema(bindableIds())),
    },
  }
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>
  additionalProperties?: boolean | SchemaNode
  [key: string]: unknown
}

const PER_PLATFORM: ReadonlySet<string> = new Set(KEYBOARD_FIELDS)

export function settingsSchemaAt(path?: string): unknown {
  let node = fullSettingsSchema() as unknown as SchemaNode
  const keys = (path ?? '').split('.').filter(Boolean)
  if (PER_PLATFORM.has(keys[0]) && !isKeyboardPlatform(keys[1])) {
    keys.splice(1, 0, keyboardPlatform(platform))
  }
  for (const key of keys) {
    const extra = node.additionalProperties
    const next = node.properties?.[key] ?? (typeof extra === 'object' ? extra : undefined)
    if (!next) throw new Error(`unknown settings key: ${path}`)
    node = next
  }
  return node
}
