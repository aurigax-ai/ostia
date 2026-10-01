import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXTENSION_LOCALES_DIR,
  EXTENSION_LOCALE_FILE_MAX_BYTES,
  type LocaleCatalogs,
  type Translate,
  parseMessages,
  translatorFor,
} from '../../shared/extensionLocales'
import { LANGUAGE_ID_PATTERN } from '../../shared/languagePack'

const CATALOG_SUFFIX = '.json'

function extensionDir(): string {
  return process.env.PINE_EXTENSION_DIR ?? process.cwd()
}

function readMessageFile(file: string): unknown {
  try {
    if (statSync(file).size > EXTENSION_LOCALE_FILE_MAX_BYTES) return undefined
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof raw === 'object' && raw !== null
      ? (raw as { messages?: unknown }).messages
      : undefined
  } catch {
    return undefined
  }
}

export function readMessages(dir: string = extensionDir()): LocaleCatalogs {
  const catalogs: LocaleCatalogs = Object.create(null)
  const folder = join(dir, EXTENSION_LOCALES_DIR)
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {}
  for (const name of names) {
    const tag = name.endsWith(CATALOG_SUFFIX) ? name.slice(0, -CATALOG_SUFFIX.length) : ''
    if (!LANGUAGE_ID_PATTERN.test(tag)) continue
    catalogs[tag] = parseMessages(readMessageFile(join(folder, name))).messages
  }
  return catalogs
}

export function createTranslator(
  dir: string = extensionDir(),
): (locale: string | undefined) => Translate {
  const catalogs = readMessages(dir)
  return (locale) => translatorFor(catalogs, locale)
}
