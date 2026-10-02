import { MATCH_PINE_THEME, parseThemeChoice } from './themeChoice'

export const SEARCH_ENGINES = ['google', 'duckduckgo', 'bing', 'kagi', 'custom'] as const

export type SearchEngine = (typeof SEARCH_ENGINES)[number]

export const SEARCH_TEMPLATES: Record<Exclude<SearchEngine, 'custom'>, string> = {
  google: 'https://www.google.com/search?q={query}',
  duckduckgo: 'https://duckduckgo.com/?q={query}',
  bing: 'https://www.bing.com/search?q={query}',
  kagi: 'https://kagi.com/search?q={query}',
}

export const QUERY_PLACEHOLDER = '{query}'

export const ZOOM_MIN = 50
export const ZOOM_MAX = 300

export interface BrowserSettings {
  searchEngine: SearchEngine
  customSearchUrl: string
  openTerminalLinks: boolean
  defaultZoom: number
  attachCaptureImage: boolean
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: 'google',
  customSearchUrl: '',
  openTerminalLinks: false,
  defaultZoom: 100,
  attachCaptureImage: true,
}

export function isValidSearchTemplate(template: string): boolean {
  if (!template.includes(QUERY_PLACEHOLDER)) return false
  try {
    const { protocol } = new URL(template.replaceAll(QUERY_PLACEHOLDER, 'q'))
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_BROWSER_SETTINGS.defaultZoom
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)))
}

export function searchUrl(settings: BrowserSettings, query: string): string {
  const template =
    settings.searchEngine === 'custom'
      ? isValidSearchTemplate(settings.customSearchUrl)
        ? settings.customSearchUrl
        : SEARCH_TEMPLATES.google
      : SEARCH_TEMPLATES[settings.searchEngine]
  return template.replaceAll(QUERY_PLACEHOLDER, encodeURIComponent(query))
}

const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}

function oneOf<T extends string | number>(options: readonly T[], value: unknown, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

export function parseBrowserSettings(raw: unknown): BrowserSettings {
  const src = record(raw)
  const defaults = DEFAULT_BROWSER_SETTINGS
  return {
    searchEngine: oneOf(SEARCH_ENGINES, src.searchEngine, defaults.searchEngine),
    customSearchUrl: typeof src.customSearchUrl === 'string' ? src.customSearchUrl : '',
    openTerminalLinks: typeof src.openTerminalLinks === 'boolean' ? src.openTerminalLinks : false,
    defaultZoom:
      typeof src.defaultZoom === 'number' ? clampZoom(src.defaultZoom) : defaults.defaultZoom,
    attachCaptureImage:
      typeof src.attachCaptureImage === 'boolean'
        ? src.attachCaptureImage
        : defaults.attachCaptureImage,
  }
}

export const WORD_WRAPS = ['off', 'on'] as const
export const LINE_NUMBER_MODES = ['on', 'off', 'relative'] as const
export const TAB_WIDTHS = [2, 4, 8] as const
export const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange'] as const
export const OPEN_FILES_IN = ['tab', 'split'] as const
export const DIFF_LAYOUTS = ['sideBySide', 'inline'] as const

export type WordWrap = (typeof WORD_WRAPS)[number]
export type LineNumberMode = (typeof LINE_NUMBER_MODES)[number]
export type TabWidth = (typeof TAB_WIDTHS)[number]
export type AutoSaveMode = (typeof AUTO_SAVE_MODES)[number]
export type OpenFilesIn = (typeof OPEN_FILES_IN)[number]
export type DiffLayout = (typeof DIFF_LAYOUTS)[number]

export const AUTO_SAVE_DELAY_MS = 1000

export interface EditorSettings {
  wordWrap: WordWrap
  lineNumbers: LineNumberMode
  tabSize: TabWidth
  insertSpaces: boolean
  autoSave: AutoSaveMode
  formatOnSave: boolean
  openFilesIn: OpenFilesIn
  theme: string
  markdownPreview: boolean
  diffLayout: DiffLayout
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  wordWrap: 'off',
  lineNumbers: 'on',
  tabSize: 2,
  insertSpaces: true,
  autoSave: 'off',
  formatOnSave: false,
  openFilesIn: 'tab',
  theme: MATCH_PINE_THEME,
  markdownPreview: false,
  diffLayout: 'sideBySide',
}

export function parseEditorSettings(raw: unknown): EditorSettings {
  const src = record(raw)
  const defaults = DEFAULT_EDITOR_SETTINGS
  return {
    wordWrap: oneOf(WORD_WRAPS, src.wordWrap, defaults.wordWrap),
    lineNumbers: oneOf(LINE_NUMBER_MODES, src.lineNumbers, defaults.lineNumbers),
    tabSize: oneOf(TAB_WIDTHS, src.tabSize, defaults.tabSize),
    insertSpaces: typeof src.insertSpaces === 'boolean' ? src.insertSpaces : true,
    autoSave: oneOf(AUTO_SAVE_MODES, src.autoSave, defaults.autoSave),
    formatOnSave: typeof src.formatOnSave === 'boolean' ? src.formatOnSave : false,
    openFilesIn: oneOf(OPEN_FILES_IN, src.openFilesIn, defaults.openFilesIn),
    theme: parseThemeChoice(src.theme),
    markdownPreview: src.markdownPreview === true,
    diffLayout: oneOf(DIFF_LAYOUTS, src.diffLayout, defaults.diffLayout),
  }
}
