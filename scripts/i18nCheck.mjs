import { loadAllow } from './i18nAllow.mjs'
import { compareCatalog } from './i18nCompare.mjs'
import { BASE_LANGUAGE, CORE_LANGUAGES, REPO_ROOT, areaFile, bundleModule, loadCatalogue } from './i18nCatalog.mjs'
import { checkExtensions } from './i18nExtensions.mjs'
import { checkLiterals } from './i18nLiterals.mjs'
import { orderProblems } from './i18nOrder.mjs'
import { checkPacks } from './i18nPacks.mjs'
import { unusedKeys } from './i18nUsage.mjs'

const SDK_ENTRY = [
  "export { parseManifest } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'",
  "export { manifestSlots } from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'",
].join('\n')

export async function runChecks(root) {
  const allow = loadAllow(root)
  const catalogue = await loadCatalogue(root)
  const sdk = await bundleModule(REPO_ROOT, SDK_ENTRY)
  const problems = []
  const core = Object.entries(catalogue.languages).map(([language, target]) => {
    const result = compareCatalog({
      source: catalogue.en,
      target,
      scope: language,
      label: language,
      fileOf: (key) => areaFile(catalogue.areaOf(key), CORE_LANGUAGES[language]),
      allow,
    })
    problems.push(...result.problems)
    return { language, rows: result.rows }
  })
  for (const key of unusedKeys(root)) {
    if (allow.unused(key)) continue
    problems.push(
      `unused: ${key}: no source outside tests reads it. Remove it from ${areaFile(catalogue.areaOf(key), BASE_LANGUAGE)} and every translation.`,
    )
  }
  problems.push(...orderProblems(root))
  const packs = checkPacks(root, catalogue, allow)
  const extensions = checkExtensions(root, sdk, allow)
  problems.push(...packs.problems, ...extensions.problems, ...checkLiterals(root, allow), ...allow.stale())
  return {
    problems: [...new Set(problems)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    coverage: { core, areaOf: catalogue.areaOf, packs: packs.packs, extensions: extensions.extensions },
  }
}

