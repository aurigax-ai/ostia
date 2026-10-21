import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repository = 'aurigax-ai/ostia'
const marketplaceRepository = 'aurigax-ai/ostia-extensions'
const sdkName = '@aurigax-ai/ostia-extension-sdk'

function parseApi(value) {
  const match = /^(\d+)\.(\d+)$/.exec(value ?? '')
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export function exceedsFloor(declared, floor) {
  const wanted = parseApi(declared)
  const have = parseApi(floor)
  return !wanted || !have || wanted.major !== have.major || wanted.minor > have.minor
}

export function floorProblems({ declared, appApi, sdk, sdkApi }) {
  const problems = []
  if (exceedsFloor(sdkApi, appApi)) {
    problems.push(
      `is typed against SDK ${sdk} (extension API ${sdkApi}), newer than ${appApi} of the latest stable app`,
    )
  }
  if (declared !== sdkApi) {
    problems.push(
      `declares extension API ${declared}, but is type-checked against SDK ${sdk}, whose API is ${sdkApi}: declare ${sdkApi}`,
    )
  }
  return problems
}

const STABLE_APP_TAG = /^v\d+\.\d+\.\d+$/

export function latestStableAppTag(releases) {
  const key = (tag) => tag.slice(1).split('.').map(Number)
  const newer = (a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
    return false
  }
  let best = null
  for (const release of releases) {
    if (release.draft || release.prerelease || !STABLE_APP_TAG.test(release.tag_name)) continue
    if (best === null || newer(release.tag_name, best)) best = release.tag_name
  }
  return best
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim()
}

function stableApi() {
  const releases = gh(
    'api',
    '--paginate',
    `repos/${repository}/releases?per_page=100`,
    '--jq',
    '.[] | {tag_name, draft, prerelease}',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const tag = latestStableAppTag(releases)
  if (!tag) throw new Error('no stable app release found')
  const lock = gh(
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository}/contents/packages/extension-sdk/api-lock.json?ref=${tag}`,
  )
  return { tag, api: JSON.parse(lock).version }
}

function pinnedSdk() {
  const text = gh(
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${marketplaceRepository}/contents/package.json?ref=${process.env.MARKETPLACE_SHA ?? 'main'}`,
  )
  return JSON.parse(text).devDependencies[sdkName]
}

async function sdkApiOf(version) {
  const response = await fetch(
    `https://registry.npmjs.org/${sdkName.replaceAll('/', '%2F')}/${version}`,
  )
  if (!response.ok) throw new Error(`npm answered ${response.status} for ${sdkName}@${version}`)
  return (await response.json()).ostiaExtensionApi
}

async function main(id) {
  const manifest = JSON.parse(readFileSync(join('src/extensions', id, 'ostia.json'), 'utf8'))
  const { tag, api: appApi } = stableApi()
  const sdk = pinnedSdk()
  const sdkApi = await sdkApiOf(sdk)
  const problems = floorProblems({ declared: manifest.api, appApi, sdk, sdkApi })
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${id} ${problem} (${tag})`)
    process.exit(1)
  }
  const lines = [`floor_api=${appApi}`, `floor_tag=${tag}`, `sdk=${sdk}`, `sdk_api=${sdkApi}`]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

if (process.argv[1] === import.meta.filename) {
  const id = process.argv[2]
  if (!id) {
    console.error('usage: node scripts/extensionFloor.mjs <extension id>')
    process.exit(1)
  }
  await main(id)
}
