import { existsSync, readFileSync } from 'node:fs'
import { REPO_ROOT } from './i18nCatalog.mjs'
import { runChecks } from './i18nCheck.mjs'
import { baselineOf, coverageMarkdown, coverageRows, sameReasons } from './i18nCoverage.mjs'
import { sortCatalogues } from './i18nOrder.mjs'

const USAGE = [
  'usage: node scripts/i18n.mjs check',
  '       node scripts/i18n.mjs sort',
  '       node scripts/i18n.mjs coverage [--json <sha>] [--baseline <baseline.json>]',
].join('\n')

function option(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

async function main(args) {
  const [verb, ...rest] = args
  if (verb === 'check') {
    const { problems } = await runChecks(REPO_ROOT)
    for (const problem of problems) console.log(problem)
    if (problems.length > 0) {
      console.log(`\ni18n: ${problems.length} problem(s)`)
      process.exitCode = 1
    }
    return
  }
  if (verb === 'sort') {
    sortCatalogues(REPO_ROOT)
    return
  }
  if (verb === 'coverage') {
    const { coverage } = await runChecks(REPO_ROOT)
    const rows = coverageRows(coverage)
    const sha = option(rest, '--json')
    if (sha !== undefined) {
      process.stdout.write(`${JSON.stringify(baselineOf(rows, sha))}\n`)
      return
    }
    const file = option(rest, '--baseline')
    const baseline = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    const same = sameReasons(coverage.core.flatMap((c) => c.rows))
    process.stdout.write(coverageMarkdown(rows, { baseline, same }))
    return
  }
  console.error(USAGE)
  process.exitCode = 2
}

await main(process.argv.slice(2))
