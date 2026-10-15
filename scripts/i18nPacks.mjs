import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compareCatalog } from './i18nCompare.mjs'
import { BASE_LANGUAGE, CORE_LANGUAGES, EXTENSIONS_DIR, GENERATED_PACKS, flatten } from './i18nCatalog.mjs'

const replacesEnglish = (id) => id === BASE_LANGUAGE || id.startsWith(`${BASE_LANGUAGE}-`)

export function extensionIds(root) {
  return readdirSync(join(root, EXTENSIONS_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, EXTENSIONS_DIR, entry.name, 'ostia.json')))
    .map((entry) => entry.name)
    .sort()
}

function packCatalogue(root, id, language, catalogue) {
  const dir = join(root, EXTENSIONS_DIR, id)
  const generated = GENERATED_PACKS[id]
  if (generated && generated.file === language.path) {
    return { strings: flatten(catalogue.exports[generated.exportName]), generated: true }
  }
  const file = join(dir, language.path)
  if (!existsSync(file)) return { error: `${language.path} does not exist` }
  try {
    return { strings: flatten(JSON.parse(readFileSync(file, 'utf8'))), generated: false }
  } catch {
    return { error: `${language.path} is not valid JSON` }
  }
}

export function checkPacks(root, catalogue, allow) {
  const problems = []
  const packs = []
  for (const id of extensionIds(root)) {
    const manifest = JSON.parse(readFileSync(join(root, EXTENSIONS_DIR, id, 'ostia.json'), 'utf8'))
    for (const language of manifest.contributes?.languages ?? []) {
      const where = `${EXTENSIONS_DIR}/${id}/${language.path}`
      if (replacesEnglish(language.id)) {
        problems.push(
          `pack replaces English: ${id} language '${language.id}' (${EXTENSIONS_DIR}/${id}/ostia.json). English is the catalogue; a pack adds another language.`,
        )
        continue
      }
      const pack = packCatalogue(root, id, language, catalogue)
      if (pack.error) {
        problems.push(`pack: ${id} language '${language.id}': ${pack.error}. Ship the catalogue at ${where}.`)
        continue
      }
      for (const key of pack.strings.keys()) {
        if (!catalogue.en.has(key)) {
          problems.push(`pack adds a key: ${id} ${language.id} ${key} (${where}): packs translate the catalogue's keys only. Remove it.`)
        }
      }
      const scope = pack.generated && CORE_LANGUAGES[language.id] ? language.id : `${id}:${language.id}`
      const result = compareCatalog({
        source: catalogue.en,
        target: new Map([...pack.strings].filter(([key]) => catalogue.en.has(key))),
        scope,
        label: `pack ${id} ${language.id}`,
        fileOf: () => where,
        allow,
        quiet: pack.generated,
      })
      problems.push(...result.problems)
      packs.push({ id, language: language.id, rows: result.rows })
    }
  }
  return { problems, packs }
}
