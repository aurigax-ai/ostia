export type PromptStyle = 'shell' | 'ostia'

export const PROMPT_STYLES: readonly PromptStyle[] = ['shell', 'ostia']

export type PromptSeparator = 'none' | '%' | '$' | '>'

export const PROMPT_SEPARATORS: readonly PromptSeparator[] = ['none', '%', '$', '>']

export const CORE_CHIP_IDS = [
  'conda',
  'virtualenv',
  'node',
  'cwd',
  'user',
  'host',
  'kube',
  'date',
  'time12',
  'time24',
  'exitCode',
  'duration',
] as const

export type CoreChipId = (typeof CORE_CHIP_IDS)[number]

export const DEFAULT_PROMPT_CHIPS: readonly string[] = [
  'conda',
  'virtualenv',
  'node',
  'cwd',
  'git.branch',
  'git.diff-stats',
]

export const MAX_PROMPT_CHIPS = 32

export interface PromptSettings {
  style: PromptStyle
  chips: string[]
  sameLine: boolean
  separator: PromptSeparator
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  style: 'shell',
  chips: [...DEFAULT_PROMPT_CHIPS],
  sameLine: false,
  separator: 'none',
}

const EXTENSION_CHIP_ID = /^[a-z][a-z0-9-]{1,39}\.[a-z][a-z0-9-]{0,39}$/

export const isCoreChipId = (id: string): id is CoreChipId =>
  (CORE_CHIP_IDS as readonly string[]).includes(id)

export const isExtensionChipId = (id: string): boolean => EXTENSION_CHIP_ID.test(id)

export const isPromptChipId = (id: unknown): id is string =>
  typeof id === 'string' && (isCoreChipId(id) || isExtensionChipId(id))

export const isPromptSeparator = (v: unknown): v is PromptSeparator =>
  PROMPT_SEPARATORS.includes(v as PromptSeparator)

export function parsePromptChips(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_PROMPT_CHIPS]
  const chips: string[] = []
  for (const id of raw) {
    if (chips.length >= MAX_PROMPT_CHIPS) break
    if (isPromptChipId(id) && !chips.includes(id)) chips.push(id)
  }
  return chips
}

export function parsePromptSettings(raw: unknown): PromptSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_PROMPT_SETTINGS, chips: [...DEFAULT_PROMPT_CHIPS] }
  }
  const source = raw as Record<string, unknown>
  const style = source.style
  return {
    style: PROMPT_STYLES.includes(style as PromptStyle)
      ? (style as PromptStyle)
      : DEFAULT_PROMPT_SETTINGS.style,
    chips: parsePromptChips(source.chips),
    sameLine: typeof source.sameLine === 'boolean' ? source.sameLine : false,
    separator: isPromptSeparator(source.separator)
      ? source.separator
      : DEFAULT_PROMPT_SETTINGS.separator,
  }
}

export const separatorText = (separator: PromptSeparator): string =>
  separator === 'none' ? '' : separator
