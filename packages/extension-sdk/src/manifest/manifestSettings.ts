import {
  EXTENSION_ICONS,
  EXTENSION_SETTING_TITLE_MAX,
  EXTENSION_SETTING_TYPES,
  EXTENSION_SETTING_UNITS,
  type ExtensionSecretContribution,
  type ExtensionSettingContribution,
  type ExtensionSettingsPageContribution,
  type ExtensionSettingType,
  type ExtensionSettingUnit,
  validSettingValue,
} from '../contract/extensions'
import { isRecord } from '../contract/isRecord'
import { hasControlCharacter, MAX_DESCRIPTION, parseIcon, text } from './manifestFields'

const MAX_SETTINGS = 32
export const MAX_ENUM_VALUES = 32
const MAX_SECRETS = 8
export const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/

export function parseSettingsPage(
  raw: unknown,
  hasEntries: boolean,
  assist: boolean,
): ExtensionSettingsPageContribution | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return 'contributes.settingsPage: must be an object'
  const title = text(raw.title, EXTENSION_SETTING_TITLE_MAX)
  if (!title || hasControlCharacter(title)) {
    return `contributes.settingsPage: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
  }
  const page: ExtensionSettingsPageContribution = { title }
  if (raw.icon !== undefined) {
    const icon = parseIcon(raw.icon)
    if (!icon) return `contributes.settingsPage: icon must be one of ${EXTENSION_ICONS.join(', ')}`
    page.icon = icon
  }
  if (!hasEntries) return 'contributes.settingsPage needs contributes.settings or secrets'
  if (assist)
    return 'contributes.settingsPage: assist extensions are set up in Settings → Assistant'
  return page
}

function parseSetting(key: string, raw: unknown): ExtensionSettingContribution | string {
  const where = `contributes.settings.${key}`
  if (!SETTING_KEY_PATTERN.test(key)) return `${where}: invalid key`
  if (!isRecord(raw)) return `${where}: must be an object`
  if (!EXTENSION_SETTING_TYPES.includes(raw.type as ExtensionSettingType)) {
    return `${where}: type must be one of ${EXTENSION_SETTING_TYPES.join(', ')}`
  }
  const description = text(raw.description, MAX_DESCRIPTION)
  if (!description) return `${where}: missing description`
  const title = optionalTitle(raw.title)
  if (title === null) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
  const setting: ExtensionSettingContribution = {
    key,
    type: raw.type as ExtensionSettingType,
    default: '',
    ...(title ? { title } : {}),
    description,
  }
  const numeric = parseNumberBounds(raw, setting.type)
  if (typeof numeric === 'string') return `${where}: ${numeric}`
  Object.assign(setting, numeric)
  if (setting.type === 'enum') {
    const values = raw.values
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_ENUM_VALUES ||
      !values.every((v) => text(v, 100) !== null)
    ) {
      return `${where}: enum needs 1-${MAX_ENUM_VALUES} string values`
    }
    setting.values = [...new Set(values as string[])]
    const valueTitles = parseValueTitles(raw.valueTitles, setting.values)
    if (typeof valueTitles === 'string') return `${where}: ${valueTitles}`
    if (valueTitles) setting.valueTitles = valueTitles
  } else if (raw.valueTitles !== undefined) {
    return `${where}: valueTitles is for enum settings`
  }
  if (!validSettingValue(setting, raw.default)) {
    return `${where}: default does not match type ${setting.type}`
  }
  setting.default = raw.default
  return setting
}

function optionalTitle(raw: unknown): string | undefined | null {
  if (raw === undefined) return undefined
  const title = text(raw, EXTENSION_SETTING_TITLE_MAX)
  if (!title || hasControlCharacter(title)) return null
  return title
}

function parseValueTitles(
  raw: unknown,
  values: readonly string[],
): Record<string, string> | string | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return 'valueTitles must be an object'
  const titles: Record<string, string> = {}
  for (const [value, title] of Object.entries(raw)) {
    if (!values.includes(value)) return `valueTitles.${value} is not one of the values`
    const parsed = optionalTitle(title)
    if (!parsed) return `valueTitles.${value} must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
    titles[value] = parsed
  }
  return titles
}

type NumberBounds = Pick<ExtensionSettingContribution, 'minimum' | 'maximum' | 'unit'>

function parseNumberBounds(
  raw: Record<string, unknown>,
  type: ExtensionSettingType,
): NumberBounds | string {
  const { minimum, maximum, unit } = raw
  if (minimum === undefined && maximum === undefined && unit === undefined) return {}
  if (type !== 'number') return 'minimum, maximum and unit are for number settings'
  const bounds: NumberBounds = {}
  for (const [name, value] of [
    ['minimum', minimum],
    ['maximum', maximum],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a number`
    bounds[name] = value
  }
  if (
    bounds.minimum !== undefined &&
    bounds.maximum !== undefined &&
    bounds.minimum > bounds.maximum
  ) {
    return 'minimum is greater than maximum'
  }
  if (unit !== undefined) {
    if (!EXTENSION_SETTING_UNITS.includes(unit as ExtensionSettingUnit)) {
      return `unit must be one of ${EXTENSION_SETTING_UNITS.join(', ')}`
    }
    bounds.unit = unit as ExtensionSettingUnit
  }
  return bounds
}

export function parseSettings(raw: unknown): ExtensionSettingContribution[] | string {
  if (raw === undefined) return []
  if (!isRecord(raw)) return 'contributes.settings must be an object'
  const entries = Object.entries(raw)
  if (entries.length > MAX_SETTINGS)
    return `contributes.settings has more than ${MAX_SETTINGS} keys`
  const settings: ExtensionSettingContribution[] = []
  for (const [key, value] of entries) {
    const parsed = parseSetting(key, value)
    if (typeof parsed === 'string') return parsed
    settings.push(parsed)
  }
  return settings
}

export function parseSecrets(raw: unknown): ExtensionSecretContribution[] | string {
  if (raw === undefined) return []
  if (!isRecord(raw)) return 'contributes.secrets must be an object'
  const entries = Object.entries(raw)
  if (entries.length > MAX_SECRETS) return `contributes.secrets has more than ${MAX_SECRETS} keys`
  const secrets: ExtensionSecretContribution[] = []
  for (const [key, value] of entries) {
    const where = `contributes.secrets.${key}`
    if (!SETTING_KEY_PATTERN.test(key)) return `${where}: invalid key`
    const description = isRecord(value) ? text(value.description, MAX_DESCRIPTION) : null
    if (!description) return `${where}: missing description`
    const title = optionalTitle((value as Record<string, unknown>).title)
    if (title === null) return `${where}: title must be 1-${EXTENSION_SETTING_TITLE_MAX} characters`
    secrets.push({ key, ...(title ? { title } : {}), description })
  }
  return secrets
}
