import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { marketplaceIds } from './marketplace.mjs'

const TAG_PATTERN = /^ext\/([a-z][a-z0-9-]{1,39})\/v(.+)$/

const SDK_TAG_PATTERN = /^sdk-v(.+)$/

export function sdkTag(version) {
  return `sdk-v${version}`
}

export function parseSdkTag(tag) {
  const match = SDK_TAG_PATTERN.exec(tag)
  return match && semver.clean(match[1]) === match[1] ? { version: match[1] } : null
}

export function sdkReleaseProblems(tag, version) {
  const parsed = parseSdkTag(tag)
  if (!parsed) return [`${tag} is not sdk-v<major.minor.patch[-rc.N]>`]
  return parsed.version === version
    ? []
    : [`${tag} says ${parsed.version} but the SDK package says ${version}`]
}

export function extensionTag(id, version) {
  return `ext/${id}/v${version}`
}

export function parseExtensionTag(tag) {
  const match = TAG_PATTERN.exec(tag)
  if (!match || !semver.valid(match[2], { loose: false }) || semver.clean(match[2]) !== match[2]) {
    return null
  }
  return { id: match[1], version: match[2] }
}

export function releaseProblems(tag, { listed, versionOf }) {
  const parsed = parseExtensionTag(tag)
  if (!parsed) return [`${tag} is not ext/<id>/v<major.minor.patch[-rc.N]>`]
  if (!listed.includes(parsed.id)) {
    return [`${parsed.id} is not an extension of marketplace/ostia-marketplace.json`]
  }
  const version = versionOf(parsed.id)
  return version === parsed.version
    ? []
    : [`${tag} says ${parsed.version} but src/extensions/${parsed.id}/ostia.json says ${version}`]
}

function manifestVersion(id) {
  return JSON.parse(readFileSync(join('src/extensions', id, 'ostia.json'), 'utf8')).version
}

function checkTag(tag) {
  const problems = releaseProblems(tag, { listed: marketplaceIds(), versionOf: manifestVersion })
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  const { id, version } = parseExtensionTag(tag)
  const lines = [
    `id=${id}`,
    `version=${version}`,
    `prerelease=${semver.prerelease(version) !== null}`,
  ]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

function sdkVersion() {
  return JSON.parse(readFileSync('packages/extension-sdk/package.json', 'utf8')).version
}

function checkSdkTag(tag) {
  const problems = sdkReleaseProblems(tag, sdkVersion())
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  const version = sdkVersion()
  const lines = [`version=${version}`, `npm_tag=${semver.prerelease(version) ? 'next' : 'latest'}`]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

function createTag(id) {
  const sdk = id === 'sdk'
  const tag = sdk ? sdkTag(sdkVersion()) : extensionTag(id, manifestVersion(id))
  const problems = sdk
    ? sdkReleaseProblems(tag, sdkVersion())
    : releaseProblems(tag, { listed: marketplaceIds(), versionOf: manifestVersion })
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exit(1)
  }
  execFileSync('git', ['tag', '-a', tag, '-m', tag], { stdio: 'inherit' })
  console.log(
    `tagged ${tag} on ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`,
  )
  console.log(`push it from main with: git push origin ${tag}`)
}

if (process.argv[1] === import.meta.filename) {
  const [verb, value] = process.argv.slice(2)
  if (verb === 'check' && value) checkTag(value)
  else if (verb === 'check-sdk' && value) checkSdkTag(value)
  else if (verb === 'tag' && value) createTag(value)
  else {
    console.error('usage: pnpm ext:release <id>   (or sdk for the extension SDK)')
    console.error('       node scripts/extensionRelease.mjs check-sdk <tag>')
    console.error('       node scripts/extensionRelease.mjs check <tag>')
    process.exit(1)
  }
}
