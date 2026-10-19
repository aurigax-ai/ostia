import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const REPO_ROOT = resolve(import.meta.dirname, '..')
export const STRINGS_DIR = 'src/shared/strings'
export const COMPOSER = 'src/shared/app/dict.ts'
export const EXTENSIONS_DIR = 'src/extensions'
export const BASE_LANGUAGE = 'en'
export const CORE_LANGUAGES = { 'zh-Hant': 'zhHant' }
const AREA_SUFFIX = 'En.ts'
export const GENERATED_PACKS = {
  'langpack-zh-hant': { exportName: 'zhHant', file: 'zh-Hant.json' },
}

const PLACEHOLDER = /\{\w+\}/g

export const repoPath = (root, file) => relative(root, file).split(sep).join('/')

export async function bundleModule(root, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-i18n-'))
  const outfile = join(dir, 'bundle.mjs')
  try {
    await build({
      stdin: { contents, resolveDir: root, loader: 'ts' },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'warning',
      nodePaths: [join(REPO_ROOT, 'node_modules')],
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function flatten(value, path = '', out = new Map()) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value))
      flatten(child, path ? `${path}.${key}` : key, out)
  } else {
    out.set(path, value)
  }
  return out
}

export function placeholders(text) {
  return [...new Set(text.match(PLACEHOLDER) ?? [])].sort()
}

export function hasText(text) {
  return /\p{L}/u.test(text.replace(PLACEHOLDER, ''))
}

export function areaNames(root) {
  return readdirSync(join(root, STRINGS_DIR))
    .filter((name) => name.endsWith(AREA_SUFFIX))
    .map((name) => name.slice(0, -AREA_SUFFIX.length))
    .sort()
}

export function areaFile(area, exportName) {
  return `${STRINGS_DIR}/${area}${exportName[0].toUpperCase()}${exportName.slice(1)}.ts`
}

export async function loadCatalogue(root) {
  const areas = areaNames(root)
  const exports = Object.values(CORE_LANGUAGES)
  const mod = await bundleModule(
    root,
    [
      `export { en, ${exports.join(', ')} } from ${JSON.stringify(join(root, COMPOSER))}`,
      ...areas.map(
        (area) =>
          `export { ${area}En } from ${JSON.stringify(join(root, areaFile(area, BASE_LANGUAGE)))}`,
      ),
    ].join('\n'),
  )
  const areaOfNamespace = new Map()
  for (const area of areas)
    for (const namespace of Object.keys(mod[`${area}En`])) areaOfNamespace.set(namespace, area)
  const languages = Object.fromEntries(
    Object.entries(CORE_LANGUAGES).map(([tag, name]) => [tag, flatten(mod[name])]),
  )
  return {
    en: flatten(mod.en),
    languages,
    exports: Object.fromEntries(exports.map((name) => [name, mod[name]])),
    areas,
    areaOf: (key) => areaOfNamespace.get(key.split('.')[0]),
  }
}
