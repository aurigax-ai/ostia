import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  apiVersion,
  readLock,
  writeApiVersion,
  writeLock,
} from '@aurigax-ai/ostia-extension-sdk/api-contract'
import { marketplaceIds } from './marketplace.mjs'

function inTreeManifests() {
  const released = new Set(marketplaceIds())
  const extensions = readdirSync('src/extensions', { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !released.has(entry.name))
    .map((entry) => join('src/extensions', entry.name, 'ostia.json'))
  return [...extensions, 'packages/extension-sdk/template/ostia.json']
}

function writeManifestApi(file, version) {
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace(/"api": "\d+\.\d+"/, `"api": "${version}"`))
}

const kind = process.argv[2]
if (kind !== 'minor' && kind !== 'major') {
  console.error('usage: pnpm api:bump <minor|major>')
  console.error('minor: something was added and existing extensions keep working')
  console.error('major: something an extension may rely on was removed or changed')
  process.exit(1)
}

const [major, minor] = readLock().version.split('.').map(Number)
const next = kind === 'major' ? `${major + 1}.0` : `${major}.${minor + 1}`
writeApiVersion(next)
for (const file of inTreeManifests()) writeManifestApi(file, next)
execFileSync('node', ['packages/extension-sdk/scripts/build.mjs'], { stdio: 'inherit' })
const built = JSON.parse(readFileSync('out/sdk/api.json', 'utf8'))
writeLock({ version: apiVersion(), digest: built.digest })
console.log(`extension API ${major}.${minor} -> ${next}`)
