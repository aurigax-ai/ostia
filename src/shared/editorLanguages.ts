import { isDangerousSegment } from './protoGuard'

export const EDITOR_LANGUAGE_ID_PATTERN = /^[a-z][a-z0-9+#-]{0,39}$/
export const PLAIN_TEXT_LANGUAGE = 'plaintext'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  zsh: 'shell',
  bash: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  java: 'java',
  lua: 'lua',
}

export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export interface EditorLanguageMapping {
  id: string
  extensions: readonly string[]
  filenames: readonly string[]
}

export function languageForPath(
  path: string,
  contributed: readonly EditorLanguageMapping[] = [],
): string {
  const extension = fileExtension(path)
  if (Object.hasOwn(LANGUAGE_BY_EXTENSION, extension)) return LANGUAGE_BY_EXTENSION[extension]
  const name = path.slice(path.lastIndexOf('/') + 1)
  const byName = contributed.find((language) => language.filenames.includes(name))
  if (byName) return byName.id
  const lower = name.toLowerCase()
  let best: { id: string; length: number } | null = null
  for (const language of contributed) {
    for (const suffix of language.extensions) {
      if (lower.length > suffix.length && lower.endsWith(suffix.toLowerCase())) {
        if (!best || suffix.length > best.length) best = { id: language.id, length: suffix.length }
      }
    }
  }
  return best?.id ?? PLAIN_TEXT_LANGUAGE
}

export const SETTINGS_LANGUAGE_ID = 'pine-settings'
export const MAX_EDITOR_LANGUAGES = 16
export const MAX_LANGUAGE_FILE_PATTERNS = 16
export const EDITOR_LANGUAGE_NAME_MAX = 80
export const EDITOR_LANGUAGE_EXTENSION_PATTERN = /^\.[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,29}$/
export const EDITOR_LANGUAGE_FILENAME_PATTERN = /^[A-Za-z0-9._+-]{1,60}$/
export const EDITOR_LANGUAGE_GRAMMAR_PATTERN = /\.json$/
export const GRAMMAR_FILE_MAX_BYTES = 256 * 1024
export const GRAMMAR_MAX_STATES = 200
export const GRAMMAR_MAX_RULES = 500
export const GRAMMAR_REGEX_MAX = 2000
const COMMENT_TOKEN_MAX = 10
const MAX_BRACKET_PAIRS = 16

export const BUILTIN_EDITOR_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  ...Object.values(LANGUAGE_BY_EXTENSION),
  PLAIN_TEXT_LANGUAGE,
  SETTINGS_LANGUAGE_ID,
])

export type BracketPair = [string, string]

export interface EditorLanguageConfiguration {
  lineComment?: string
  blockComment?: BracketPair
  brackets?: BracketPair[]
  autoClosingPairs?: BracketPair[]
}

export interface EditorLanguageContribution extends EditorLanguageMapping {
  name: string
  extensions: string[]
  filenames: string[]
  configuration: EditorLanguageConfiguration
  grammar: string
}

export interface MonarchGrammar {
  tokenizer: Record<string, unknown[]>
  [key: string]: unknown
}

export interface EditorLanguage extends EditorLanguageMapping {
  extId: string
  name: string
  extensions: string[]
  filenames: string[]
  configuration: EditorLanguageConfiguration
  grammar: MonarchGrammar
}

export interface EditorLanguagesApi {
  load: () => Promise<EditorLanguage[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= COMMENT_TOKEN_MAX
}

function pair(value: unknown): BracketPair | null {
  return Array.isArray(value) && value.length === 2 && shortToken(value[0]) && shortToken(value[1])
    ? [value[0], value[1]]
    : null
}

function pairs(raw: unknown, where: string): BracketPair[] | string | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_BRACKET_PAIRS) {
    return `${where} must be at most ${MAX_BRACKET_PAIRS} pairs`
  }
  const out: BracketPair[] = []
  for (const item of raw) {
    const parsed = pair(item)
    if (!parsed) return `${where} must hold pairs of short strings`
    out.push(parsed)
  }
  return out
}

function parseConfiguration(raw: unknown, where: string): EditorLanguageConfiguration | string {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return `${where} must be an object`
  const configuration: EditorLanguageConfiguration = {}
  if (raw.lineComment !== undefined) {
    if (!shortToken(raw.lineComment)) return `${where}.lineComment must be a short string`
    configuration.lineComment = raw.lineComment
  }
  if (raw.blockComment !== undefined) {
    const block = pair(raw.blockComment)
    if (!block) return `${where}.blockComment must be a pair of short strings`
    configuration.blockComment = block
  }
  const brackets = pairs(raw.brackets, `${where}.brackets`)
  if (typeof brackets === 'string') return brackets
  if (brackets) configuration.brackets = brackets
  const autoClosingPairs = pairs(raw.autoClosingPairs, `${where}.autoClosingPairs`)
  if (typeof autoClosingPairs === 'string') return autoClosingPairs
  if (autoClosingPairs) configuration.autoClosingPairs = autoClosingPairs
  return configuration
}

function patterns(raw: unknown, pattern: RegExp, where: string): string[] | string {
  if (raw === undefined) return []
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_LANGUAGE_FILE_PATTERNS ||
    !raw.every((item) => typeof item === 'string' && pattern.test(item))
  ) {
    return `${where} must be at most ${MAX_LANGUAGE_FILE_PATTERNS} names`
  }
  return [...new Set(raw as string[])]
}

export function parseEditorLanguages(
  raw: unknown,
  isInside: (path: string) => boolean,
): EditorLanguageContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_EDITOR_LANGUAGES) {
    return `contributes.editorLanguages must be an array of at most ${MAX_EDITOR_LANGUAGES}`
  }
  const languages: EditorLanguageContribution[] = []
  for (const [index, item] of raw.entries()) {
    const where = `contributes.editorLanguages[${index}]`
    if (!isRecord(item)) return `${where}: must be an object`
    const { id, name, grammar } = item
    if (typeof id !== 'string' || !EDITOR_LANGUAGE_ID_PATTERN.test(id))
      return `${where}: invalid id`
    if (BUILTIN_EDITOR_LANGUAGE_IDS.has(id)) {
      return `${where}: '${id}' is a language the editor already has`
    }
    if (languages.some((language) => language.id === id)) return `${where}: duplicate id '${id}'`
    if (typeof name !== 'string' || !name.trim() || name.length > EDITOR_LANGUAGE_NAME_MAX) {
      return `${where}: name must be 1-${EDITOR_LANGUAGE_NAME_MAX} characters`
    }
    const extensions = patterns(
      item.extensions,
      EDITOR_LANGUAGE_EXTENSION_PATTERN,
      `${where}.extensions`,
    )
    if (typeof extensions === 'string') return extensions
    const filenames = patterns(
      item.filenames,
      EDITOR_LANGUAGE_FILENAME_PATTERN,
      `${where}.filenames`,
    )
    if (typeof filenames === 'string') return filenames
    if (extensions.length + filenames.length === 0) {
      return `${where}: needs at least one extension or file name`
    }
    const configuration = parseConfiguration(item.configuration, `${where}.configuration`)
    if (typeof configuration === 'string') return configuration
    if (
      typeof grammar !== 'string' ||
      !EDITOR_LANGUAGE_GRAMMAR_PATTERN.test(grammar) ||
      !isInside(grammar)
    ) {
      return `${where}: grammar must be a .json file inside the extension`
    }
    languages.push({ id, name, extensions, filenames, configuration, grammar })
  }
  return languages
}

function compiles(source: string): boolean {
  if (source.length > GRAMMAR_REGEX_MAX) return false
  try {
    new RegExp(source.replace(/@[A-Za-z_]\w*/g, 'x'))
    return true
  } catch {
    return false
  }
}

function ruleRegex(rule: unknown): unknown {
  if (Array.isArray(rule)) return rule[0]
  if (isRecord(rule)) return rule.regex
  return undefined
}

function cleanGrammarValue(value: unknown, depth: number): unknown {
  if (depth > 12) return undefined
  if (Array.isArray(value)) return value.map((item) => cleanGrammarValue(item, depth + 1))
  if (!isRecord(value)) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isDangerousSegment(key)) continue
    const cleaned = cleanGrammarValue(item, depth + 1)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

export function validateMonarchGrammar(raw: unknown): MonarchGrammar | string {
  const grammar = cleanGrammarValue(raw, 0)
  if (!isRecord(grammar)) return 'must be a JSON object'
  const { tokenizer } = grammar
  if (!isRecord(tokenizer)) return 'tokenizer must be an object of states'
  const states = Object.entries(tokenizer)
  if (states.length === 0 || states.length > GRAMMAR_MAX_STATES) {
    return `tokenizer must have 1-${GRAMMAR_MAX_STATES} states`
  }
  for (const [state, rules] of states) {
    if (!Array.isArray(rules) || rules.length > GRAMMAR_MAX_RULES) {
      return `tokenizer.${state} must be an array of at most ${GRAMMAR_MAX_RULES} rules`
    }
    for (const [index, rule] of rules.entries()) {
      if (isRecord(rule) && typeof rule.include === 'string') continue
      const regex = ruleRegex(rule)
      if (typeof regex !== 'string' || !compiles(regex)) {
        return `tokenizer.${state}[${index}] does not start with a regular expression that compiles`
      }
    }
  }
  for (const [key, value] of Object.entries(grammar)) {
    if (key !== 'defaultToken' && typeof value === 'string' && !compiles(value)) {
      return `${key} is not a regular expression that compiles`
    }
  }
  return grammar as MonarchGrammar
}
