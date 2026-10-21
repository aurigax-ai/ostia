import { z } from 'zod'
import {
  AGENT_HOOK_EVENTS,
  AGENT_SKILL_ENTRY,
  AGENT_SKILL_FILE_PATTERN,
  AGENT_SKILL_NAME_PATTERN,
  MAX_AGENT_HOOKS,
  MAX_AGENT_SKILL_FILES,
  MAX_AGENT_SKILLS,
} from '../contract/agentPlugins'
import { ASSIST_POINTS } from '../contract/assist'
import { ALL_CAPABILITIES } from '../contract/capabilities'
import {
  BUILTIN_EDITOR_LANGUAGE_IDS,
  EDITOR_LANGUAGE_EXTENSION_PATTERN,
  EDITOR_LANGUAGE_FILENAME_PATTERN,
  EDITOR_LANGUAGE_GRAMMAR_PATTERN,
  EDITOR_LANGUAGE_ID_PATTERN,
  EDITOR_LANGUAGE_NAME_MAX,
  MAX_EDITOR_LANGUAGES,
  MAX_LANGUAGE_FILE_PATTERNS,
} from '../contract/editorLanguages'
import { EXTENSION_API_PATTERN } from '../contract/extensionApi'
import {
  EXTENSION_CONNECTION_FIELD_TYPES,
  EXTENSION_CONNECTION_FIELDS_MAX,
  EXTENSION_CONNECTION_KIND_PATTERN,
  EXTENSION_CONNECTION_KINDS_MAX,
  EXTENSION_CONNECTION_SECRETS_MAX,
  EXTENSION_CONNECTION_VALUE_MAX,
} from '../contract/extensionConnections'
import { EXTENSION_LOCALES_MAX } from '../contract/extensionLocales'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  EXTENSION_CATEGORIES,
  EXTENSION_ICONS,
  EXTENSION_SETTING_TITLE_MAX,
  EXTENSION_SETTING_TYPES,
  EXTENSION_SETTING_UNITS,
  EXTENSION_VERB_PATTERN,
  PANEL_TAB_SURFACES,
  PANEL_TOOLBAR_MAX_ACTIONS,
  PANEL_TOOLBAR_MAX_TABS,
} from '../contract/extensions'
import {
  FILE_KIND_DISPLAY_NAME_MAX,
  FILE_KIND_ID_PATTERN,
  FILE_KIND_SELECTORS_MAX,
  FILE_KIND_VIEW_PRIORITIES,
  FILE_KINDS_MAX,
  FILENAME_PATTERN_PATTERN,
} from '../contract/fileKinds'
import { ICON_THEME_ID_PATTERN } from '../contract/iconTheme'
import { KEYMAP_LABEL_MAX, KEYMAP_PLATFORMS } from '../contract/keymap'
import { LANGUAGE_ID_PATTERN } from '../contract/languagePack'
import {
  DOWNLOAD_URL_MAX,
  GO_MODULE_MAX,
  LANGUAGE_SERVER_ARCHIVES,
  LANGUAGE_SERVER_DOCUMENT_ID_PATTERN,
  LANGUAGE_SERVER_EXECUTABLE_PATTERN,
  LANGUAGE_SERVER_GO_MODULE_PATTERN,
  LANGUAGE_SERVER_GO_VERSION_PATTERN,
  LANGUAGE_SERVER_ID_PATTERN,
  LANGUAGE_SERVER_MARKER_PATTERN,
  LANGUAGE_SERVER_PLATFORMS,
  LANGUAGE_SERVER_PROGRAM_PATTERN,
  LANGUAGE_SERVER_SCRIPT_PATTERN,
  LANGUAGE_SERVER_SETTING_PATH_PATTERN,
  LANGUAGE_SERVER_SHA256_PATTERN,
  LANGUAGE_SERVER_VERSION_PATTERN,
  MAX_LANGUAGE_SERVERS,
  MAX_ROOT_MARKERS,
  MAX_SERVER_ARGS,
  MAX_SERVER_LANGUAGES,
  SERVER_ARG_MAX,
  SERVER_NAME_MAX,
} from '../contract/languageServers'
import { isCoreSource, verbProblem } from './coreNames'
import {
  KEYMAP_ID_PATTERN,
  MAX_CHIPS,
  MAX_COMMANDS,
  MAX_ICON_THEMES,
  MAX_KEYMAPS,
  MAX_LANGUAGES,
  MAX_SNIPPETS,
} from './manifestContributions'
import {
  COMMAND_ID_PATTERN,
  EXTENSION_ID_PATTERN,
  MAX_DESCRIPTION,
  MAX_TEXT,
} from './manifestFields'
import { MAX_ENUM_VALUES, SETTING_KEY_PATTERN } from './manifestSettings'
import {
  MARKETPLACE_CODE_PATTERN,
  MARKETPLACE_DESCRIPTION_MAX,
  MARKETPLACE_MAX_EXTENSIONS,
  MARKETPLACE_NAME_MAX,
} from './marketplaceManifest'

const VERSION_MAX = 40

const text = z.string().min(1).max(MAX_TEXT)
const title = z.string().min(1).max(EXTENSION_SETTING_TITLE_MAX)
const capabilities = z.array(z.enum(ALL_CAPABILITIES))

const command = z.looseObject({
  id: z.string().regex(COMMAND_ID_PATTERN),
  title: text,
  category: text.optional(),
  usage: text.optional(),
  argument: z.string().min(1).max(COMMAND_ARGUMENT_LABEL_MAX).optional(),
  palette: z.boolean().optional(),
  stdin: z.boolean().optional(),
  interactive: z.boolean().optional(),
  needsPlaybook: z.boolean().optional(),
  capabilities: capabilities.optional(),
})

const setting = z.looseObject({
  type: z.enum(EXTENSION_SETTING_TYPES),
  default: z.union([z.string(), z.number(), z.boolean()]),
  description: z.string().min(1).max(MAX_DESCRIPTION),
  title: title.optional(),
  values: z.array(z.string().min(1)).min(1).max(MAX_ENUM_VALUES).optional(),
  valueTitles: z.record(z.string(), title).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  unit: z.enum(EXTENSION_SETTING_UNITS).optional(),
})

const secret = z.looseObject({
  description: z.string().min(1).max(MAX_DESCRIPTION),
  title: title.optional(),
})

const CONNECTION_ENUM_MAX = 32

const connectionField = z
  .looseObject({
    title,
    description: z.string().min(1).max(MAX_DESCRIPTION).optional(),
    type: z.enum(EXTENSION_CONNECTION_FIELD_TYPES),
    enum: z.array(title).min(1).max(CONNECTION_ENUM_MAX).optional(),
    default: z.string().max(EXTENSION_CONNECTION_VALUE_MAX).optional(),
    required: z.boolean().optional(),
  })
  .refine((f) => (f.type === 'enum') === (f.enum !== undefined), 'enum is for enum fields')
  .refine((f) => !f.enum || new Set(f.enum).size === f.enum.length, 'enum values are distinct')
  .refine(
    (f) => !f.enum || f.default === undefined || f.enum.includes(f.default),
    'default is not in enum',
  )

const connectionKind = z
  .looseObject({
    kind: z.string().regex(EXTENSION_CONNECTION_KIND_PATTERN),
    title,
    description: z.string().min(1).max(MAX_DESCRIPTION).optional(),
    fields: z
      .record(z.string().regex(SETTING_KEY_PATTERN), connectionField)
      .refine((f) => Object.keys(f).length <= EXTENSION_CONNECTION_FIELDS_MAX),
    secrets: z
      .record(
        z.string().regex(SETTING_KEY_PATTERN),
        z.looseObject({ title, description: z.string().min(1).max(MAX_DESCRIPTION).optional() }),
      )
      .refine((s) => Object.keys(s).length <= EXTENSION_CONNECTION_SECRETS_MAX)
      .optional(),
  })
  .refine(
    (k) => Object.keys(k.secrets ?? {}).every((key) => !Object.hasOwn(k.fields, key)),
    'a secret is also a field',
  )

const connections = z
  .array(connectionKind)
  .min(1)
  .max(EXTENSION_CONNECTION_KINDS_MAX)
  .refine(
    (kinds) => new Set(kinds.map((k) => k.kind)).size === kinds.length,
    'a kind is declared twice',
  )

const chips = z
  .array(z.looseObject({ id: z.string().regex(COMMAND_ID_PATTERN), title: text }))
  .max(MAX_CHIPS)

const settingKey = z.string().regex(SETTING_KEY_PATTERN)

const serverArgs = z.array(z.string().max(SERVER_ARG_MAX)).max(MAX_SERVER_ARGS)
const serverProgram = z.string().regex(LANGUAGE_SERVER_PROGRAM_PATTERN)
const downloadUrl =
  /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//

const serverAsset = z.strictObject({
  url: z.string().max(DOWNLOAD_URL_MAX).regex(downloadUrl),
  sha256: z.string().regex(LANGUAGE_SERVER_SHA256_PATTERN),
  archive: z.enum(LANGUAGE_SERVER_ARCHIVES),
  executable: z.string().regex(LANGUAGE_SERVER_EXECUTABLE_PATTERN),
})

const languageServer = z.looseObject({
  id: z.string().regex(LANGUAGE_SERVER_ID_PATTERN),
  name: z.string().min(1).max(SERVER_NAME_MAX),
  languages: z.array(z.string().regex(EDITOR_LANGUAGE_ID_PATTERN)).min(1).max(MAX_SERVER_LANGUAGES),
  documentLanguageIds: z
    .record(z.string(), z.string().regex(LANGUAGE_SERVER_DOCUMENT_ID_PATTERN))
    .optional(),
  run: z.union([
    z.strictObject({
      node: z.string().regex(LANGUAGE_SERVER_SCRIPT_PATTERN),
      args: serverArgs.optional(),
    }),
    z.strictObject({
      program: serverProgram,
      package: serverProgram.optional(),
      args: serverArgs.optional(),
    }),
    z.strictObject({
      download: z.strictObject({
        program: serverProgram,
        version: z.string().regex(LANGUAGE_SERVER_VERSION_PATTERN),
        assets: z
          .partialRecord(z.enum(LANGUAGE_SERVER_PLATFORMS), serverAsset)
          .refine((assets) => Object.keys(assets).length > 0),
      }),
      args: serverArgs.optional(),
    }),
    z.strictObject({
      goInstall: z.strictObject({
        module: z.string().max(GO_MODULE_MAX).regex(LANGUAGE_SERVER_GO_MODULE_PATTERN),
        version: z.string().regex(LANGUAGE_SERVER_GO_VERSION_PATTERN),
        binary: serverProgram,
      }),
      args: serverArgs.optional(),
    }),
  ]),
  rootMarkers: z
    .array(z.string().regex(LANGUAGE_SERVER_MARKER_PATTERN))
    .max(MAX_ROOT_MARKERS)
    .optional(),
  initializationOptions: z.looseObject({}).optional(),
  settings: z.looseObject({}).optional(),
  settingPaths: z
    .record(settingKey, z.string().regex(LANGUAGE_SERVER_SETTING_PATH_PATTERN))
    .optional(),
})

const shortPair = z.tuple([z.string().min(1).max(10), z.string().min(1).max(10)])

const editorLanguage = z.looseObject({
  id: z
    .string()
    .regex(EDITOR_LANGUAGE_ID_PATTERN)
    .refine((id) => !BUILTIN_EDITOR_LANGUAGE_IDS.has(id)),
  name: z.string().min(1).max(EDITOR_LANGUAGE_NAME_MAX),
  extensions: z
    .array(z.string().regex(EDITOR_LANGUAGE_EXTENSION_PATTERN))
    .max(MAX_LANGUAGE_FILE_PATTERNS)
    .optional(),
  filenames: z
    .array(z.string().regex(EDITOR_LANGUAGE_FILENAME_PATTERN))
    .max(MAX_LANGUAGE_FILE_PATTERNS)
    .optional(),
  configuration: z
    .looseObject({
      lineComment: z.string().min(1).max(10).optional(),
      blockComment: shortPair.optional(),
      brackets: z.array(shortPair).max(16).optional(),
      autoClosingPairs: z.array(shortPair).max(16).optional(),
    })
    .optional(),
  grammar: z.string().regex(EDITOR_LANGUAGE_GRAMMAR_PATTERN),
})

const contributes = z.looseObject({
  commands: z.array(command).max(MAX_COMMANDS).optional(),
  sidebarItems: z.boolean().optional(),
  panel: z
    .looseObject({
      title: text,
      entry: z.string().min(1),
      icon: z.enum(EXTENSION_ICONS).optional(),
      toolbar: z
        .looseObject({
          tabs: z
            .array(
              z.looseObject({
                id: z.string().regex(COMMAND_ID_PATTERN),
                title: text,
                surface: z.enum(PANEL_TAB_SURFACES).optional(),
              }),
            )
            .max(PANEL_TOOLBAR_MAX_TABS)
            .optional(),
          actions: z
            .array(
              z.looseObject({
                id: z.string().regex(COMMAND_ID_PATTERN),
                title: text,
                icon: z.enum(EXTENSION_ICONS),
              }),
            )
            .max(PANEL_TOOLBAR_MAX_ACTIONS)
            .optional(),
        })
        .optional(),
    })
    .optional(),
  paneChips: chips.optional(),
  workspaceChips: chips.optional(),
  settings: z.record(settingKey, setting).optional(),
  settingsPage: z
    .looseObject({
      title,
      icon: z.enum(EXTENSION_ICONS).optional(),
    })
    .optional(),
  secrets: z.record(settingKey, secret).optional(),
  connections: connections.optional(),
  assist: z.array(z.enum(ASSIST_POINTS)).optional(),
  snippets: z.array(z.looseObject({})).max(MAX_SNIPPETS).optional(),
  completions: z.string().min(1).optional(),
  iconThemes: z
    .array(
      z.looseObject({
        id: z.string().regex(ICON_THEME_ID_PATTERN),
        label: text,
        path: z.string().regex(/\.json$/),
      }),
    )
    .max(MAX_ICON_THEMES)
    .optional(),
  languages: z
    .array(
      z.looseObject({
        id: z.string().regex(LANGUAGE_ID_PATTERN),
        label: text,
        path: z.string().regex(/\.json$/),
      }),
    )
    .max(MAX_LANGUAGES)
    .optional(),
  keymaps: z
    .array(
      z.looseObject({
        id: z.string().regex(KEYMAP_ID_PATTERN),
        label: z.string().min(1).max(KEYMAP_LABEL_MAX),
        path: z.string().regex(/\.json$/),
        platform: z.enum(KEYMAP_PLATFORMS).optional(),
      }),
    )
    .max(MAX_KEYMAPS)
    .optional(),
  languageServers: z.array(languageServer).max(MAX_LANGUAGE_SERVERS).optional(),
  editorLanguages: z.array(editorLanguage).max(MAX_EDITOR_LANGUAGES).optional(),
  fileKinds: z
    .array(
      z
        .looseObject({
          id: z.string().regex(FILE_KIND_ID_PATTERN),
          displayName: z.string().min(1).max(FILE_KIND_DISPLAY_NAME_MAX),
          selector: z
            .array(z.looseObject({ filenamePattern: z.string().regex(FILENAME_PATTERN_PATTERN) }))
            .min(1)
            .max(FILE_KIND_SELECTORS_MAX),
          view: z
            .looseObject({
              entry: z.string().regex(/\.html$/),
              priority: z.enum(FILE_KIND_VIEW_PRIORITIES).optional(),
            })
            .optional(),
          browse: z.looseObject({}).optional(),
        })
        .refine((kind) => kind.view !== undefined || kind.browse !== undefined),
    )
    .max(FILE_KINDS_MAX)
    .optional(),
  agentSkills: z
    .array(
      z.looseObject({
        name: z.string().regex(AGENT_SKILL_NAME_PATTERN),
        path: z.string().min(1),
        files: z
          .array(
            z
              .string()
              .regex(AGENT_SKILL_FILE_PATTERN)
              .refine((file) => file !== AGENT_SKILL_ENTRY),
          )
          .max(MAX_AGENT_SKILL_FILES)
          .optional(),
        bare: z.boolean().optional(),
      }),
    )
    .max(MAX_AGENT_SKILLS)
    .optional(),
  agentHooks: z
    .array(
      z.looseObject({
        event: z.enum(AGENT_HOOK_EVENTS),
        command: z.string().regex(COMMAND_ID_PATTERN),
      }),
    )
    .max(MAX_AGENT_HOOKS)
    .optional(),
  verb: z
    .string()
    .regex(EXTENSION_VERB_PATTERN)
    .refine((verb) => verbProblem(verb) === null, {
      message: 'contributes.verb is a built-in verb',
    })
    .optional(),
})

export const extensionManifestSchema = z.looseObject({
  id: z
    .string()
    .regex(EXTENSION_ID_PATTERN)
    .refine((id) => !isCoreSource(id)),
  name: text,
  version: z.string().min(1).max(VERSION_MAX),
  api: z.string().regex(EXTENSION_API_PATTERN),
  description: z.string().optional(),
  category: z.enum(EXTENSION_CATEGORIES).optional(),
  capabilities: capabilities.optional(),
  main: z.string().min(1).optional(),
  locales: z.array(z.string().regex(LANGUAGE_ID_PATTERN)).max(EXTENSION_LOCALES_MAX).optional(),
  contributes: contributes.optional(),
})

export const marketplaceManifestSchema = z.looseObject({
  name: z.string().min(1).max(MARKETPLACE_NAME_MAX),
  description: z.string().max(MARKETPLACE_DESCRIPTION_MAX).optional(),
  extensions: z.array(z.string().min(1)).max(MARKETPLACE_MAX_EXTENSIONS),
  unlisted: z
    .array(
      z.looseObject({
        path: z.string().min(1),
        code: z.string().regex(MARKETPLACE_CODE_PATTERN),
      }),
    )
    .max(MARKETPLACE_MAX_EXTENSIONS)
    .optional(),
})

export function jsonSchemas(): { extension: unknown; marketplace: unknown } {
  return {
    extension: z.toJSONSchema(extensionManifestSchema, { target: 'draft-7' }),
    marketplace: z.toJSONSchema(marketplaceManifestSchema, { target: 'draft-7' }),
  }
}
