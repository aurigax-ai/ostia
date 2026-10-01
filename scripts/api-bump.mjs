import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { apiVersion, readLock, writeApiVersion, writeLock } from './api-contract.mjs'

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
execFileSync('node', ['scripts/build-sdk.mjs'], { stdio: 'inherit' })
const built = JSON.parse(readFileSync('out/sdk/api.json', 'utf8'))
writeLock({ version: apiVersion(), digest: built.digest })
console.log(`extension API ${major}.${minor} -> ${next}`)
