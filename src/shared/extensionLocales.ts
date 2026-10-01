import { isDangerousSegment } from './protoGuard'

export const EXTENSION_LOCALES_DIR = 'locales'
export const EXTENSION_LOCALES_MAX = 32
export const EXTENSION_LOCALE_FILE_MAX_BYTES = 256 * 1024
export const EXTENSION_MESSAGES_MAX = 2000
export const EXTENSION_MESSAGE_MAX = 4000
export const EXTENSION_MESSAGE_KEY_MAX = 120
export const EXTENSION_BASE_LOCALE = 'en'
export const LOCALE_CHANGED_EVENT = 'locale.changed'

export interface ExtensionLocaleChangedPayload {
  locale: string
}

export type LocaleStrings = Record<string, string>

export type LocaleCatalogs = Record<string, LocaleStrings>

export type MessageVars = Record<string, string | number>

export type Translate = (key: string, vars?: MessageVars) => string

export function extensionLocaleFile(tag: string): string {
  return `${EXTENSION_LOCALES_DIR}/${tag}.json`
}

export function matchLocale(
  locale: string | undefined,
  available: readonly string[],
): string | undefined {
  if (!locale) return undefined
  const subtags = locale.toLowerCase().split('-')
  for (let length = subtags.length; length > 0; length--) {
    const wanted = subtags.slice(0, length).join('-')
    const exact = available.find((tag) => tag.toLowerCase() === wanted)
    if (exact) return exact
  }
  return available.find((tag) => tag.toLowerCase().split('-')[0] === subtags[0])
}

export function formatMessage(template: string, vars: MessageVars = {}): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
  )
}

export function localized<T>(
  catalogs: { en: T } & Record<string, T>,
  locale: string | undefined,
): T {
  const tag = matchLocale(locale, Object.keys(catalogs))
  return tag ? catalogs[tag] : catalogs.en
}

function messageIn(catalog: LocaleStrings | undefined, key: string): string | undefined {
  return catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined
}

export function translatorFor(catalogs: LocaleCatalogs, locale: string | undefined): Translate {
  const tag = matchLocale(locale, Object.keys(catalogs))
  const own = tag ? catalogs[tag] : undefined
  const base = Object.hasOwn(catalogs, EXTENSION_BASE_LOCALE)
    ? catalogs[EXTENSION_BASE_LOCALE]
    : undefined
  return (key, vars) => formatMessage(messageIn(own, key) ?? messageIn(base, key) ?? key, vars)
}

export interface ParsedMessages {
  messages: LocaleStrings
  problems: string[]
}

export function parseMessages(raw: unknown): ParsedMessages {
  const messages: LocaleStrings = Object.create(null)
  const problems: string[] = []
  if (raw === undefined) return { messages, problems }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { messages, problems: ['messages must be an object of strings'] }
  }
  const entries = Object.entries(raw)
  if (entries.length > EXTENSION_MESSAGES_MAX) {
    problems.push(`messages holds more than ${EXTENSION_MESSAGES_MAX} strings`)
  }
  for (const [key, value] of entries.slice(0, EXTENSION_MESSAGES_MAX)) {
    if (!key || key.length > EXTENSION_MESSAGE_KEY_MAX || isDangerousSegment(key)) {
      problems.push(`messages.${key}: not a usable key`)
    } else if (typeof value !== 'string') {
      problems.push(`messages.${key}: must be a string`)
    } else if (value.length > EXTENSION_MESSAGE_MAX) {
      problems.push(`messages.${key}: longer than ${EXTENSION_MESSAGE_MAX} characters`)
    } else {
      messages[key] = value
    }
  }
  return { messages, problems }
}
