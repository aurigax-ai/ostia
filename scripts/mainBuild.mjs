import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { githubRequestFrom } from './github.mjs'
import { passingCiResultRuns } from './mergeQueueVerified.mjs'

export const MAIN_BUILDS_KEPT = 10
const MAIN_TAG = /^v\d+\.\d+\.\d+-main\.([1-9]\d*)$/
const USAGE = [
  'usage: node scripts/mainBuild.mjs ci-passed <sha>',
  '       node scripts/mainBuild.mjs prune <releases.json> [keep]',
].join('\n')

export function mainBuildRunOf(tag) {
  const match = typeof tag === 'string' ? MAIN_TAG.exec(tag) : null
  return match ? Number(match[1]) : null
}

export function tagsToPrune(releases, keep = MAIN_BUILDS_KEPT) {
  return (releases ?? [])
    .filter((release) => release?.isPrerelease === true && mainBuildRunOf(release.tagName) !== null)
    .sort((a, b) => mainBuildRunOf(b.tagName) - mainBuildRunOf(a.tagName))
    .slice(keep)
    .map((release) => release.tagName)
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

async function main(args, env) {
  const [verb, ...rest] = args
  if (verb === 'ci-passed' && rest.length === 1) {
    const passing = await passingCiResultRuns(rest[0], githubRequestFrom(env))
    console.log(passing.length > 0 ? 'true' : 'false')
    return 0
  }
  if (verb === 'prune' && (rest.length === 1 || rest.length === 2)) {
    const keep = rest[1] === undefined ? MAIN_BUILDS_KEPT : Number(rest[1])
    if (!Number.isInteger(keep) || keep < 1) {
      console.error(USAGE)
      return 2
    }
    for (const tag of tagsToPrune(readJson(rest[0]), keep)) console.log(tag)
    return 0
  }
  console.error(USAGE)
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env)
}
