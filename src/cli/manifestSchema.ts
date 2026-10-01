import { z } from 'zod'
import {
  COMMAND_ID_PATTERN,
  EXTENSION_ID_PATTERN,
  MAX_CHIPS,
  MAX_COMMANDS,
  MAX_DESCRIPTION,
  MAX_ENUM_VALUES,
  MAX_ICON_THEMES,
  MAX_LANGUAGES,
  MAX_TEXT,
  MAX_WORKFLOWS,
  SETTING_KEY_PATTERN,
} from '../main/extensionManifest'
import {
  MARKETPLACE_DESCRIPTION_MAX,
  MARKETPLACE_MAX_EXTENSIONS,
  MARKETPLACE_NAME_MAX,
} from '../main/marketplace'
import { ASSIST_POINTS } from '../shared/assist'
import { ALL_CAPABILITIES } from '../shared/capabilities'
import {
  BUILTIN_EDITOR_LANGUAGE_IDS,
  EDITOR_LANGUAGE_EXTENSION_PATTERN,
  EDITOR_LANGUAGE_FILENAME_PATTERN,
  EDITOR_LANGUAGE_GRAMMAR_PATTERN,
  EDITOR_LANGUAGE_ID_PATTERN,
  EDITOR_LANGUAGE_NAME_MAX,
  MAX_EDITOR_LANGUAGES,
  MAX_LANGUAGE_FILE_PATTERNS,
} from '../shared/editorLanguages'
import { EXTENSION_API_PATTERN } from '../shared/extensionApi'
import { EXTENSION_LOCALES_MAX } from '../shared/extensionLocales'
import {
  COMMAND_ARGUMENT_LABEL_MAX,
  EXTENSION_CATEGORIES,
  EXTENSION_ICONS,
  EXTENSION_SETTING_TITLE_MAX,
  EXTENSION_SETTING_TYPES,
  EXTENSION_SETTING_UNITS,
} from '../shared/extensions'
import { ICON_THEME_ID_PATTERN } from '../shared/iconTheme'
import { LANGUAGE_ID_PATTERN } from '../shared/languagePack'
import {
  DOWNLOAD_URL_MAX,
  GO_MODULE_MAX,
  LANGUAGE_SERVER_ARCHIVES,
  LANGUAGE_SERVER_DOCUMENT_ID_PATTERN,
  LANGUAGE_SERVER_DOWNLOAD_HOSTS,
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
} from '../shared/languageServers'

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

const chips = z
  .array(z.looseObject({ id: z.string().regex(COMMAND_ID_PATTERN), title: text }))
  .max(MAX_CHIPS)

const settingKey = z.string().regex(SETTING_KEY_PATTERN)

const serverArgs = z.array(z.string().max(SERVER_ARG_MAX)).max(MAX_SERVER_ARGS)
const serverProgram = z.string().regex(LANGUAGE_SERVER_PROGRAM_PATTERN)
const downloadUrl = new RegExp(
  `^https://(${LANGUAGE_SERVER_DOWNLOAD_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|')})/`,
)

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
    })
    .optional(),
  paneChips: chips.optional(),
  workspaceChips: chips.optional(),
  settings: z.record(settingKey, setting).optional(),
  secrets: z.record(settingKey, secret).optional(),
  assist: z.array(z.enum(ASSIST_POINTS)).optional(),
  workflows: z.array(z.looseObject({})).max(MAX_WORKFLOWS).optional(),
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
  languageServers: z.array(languageServer).max(MAX_LANGUAGE_SERVERS).optional(),
  editorLanguages: z.array(editorLanguage).max(MAX_EDITOR_LANGUAGES).optional(),
})

export const extensionManifestSchema = z.looseObject({
  id: z.string().regex(EXTENSION_ID_PATTERN),
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
})

export function jsonSchemas(): { extension: unknown; marketplace: unknown } {
  return {
    extension: z.toJSONSchema(extensionManifestSchema, { target: 'draft-7' }),
    marketplace: z.toJSONSchema(marketplaceManifestSchema, { target: 'draft-7' }),
  }
}
