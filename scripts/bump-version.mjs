import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEVELS = ['patch', 'minor', 'major']
const level = process.argv[2]
if (!LEVELS.includes(level)) {
  console.error(`usage: pnpm bump <${LEVELS.join('|')}>`)
  process.exit(1)
}

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const text = readFileSync(path, 'utf8')
const pkg = JSON.parse(text)
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
if (!match) {
  console.error(`package.json version is not x.y.z: ${pkg.version}`)
  process.exit(1)
}
let [major, minor, patch] = match.slice(1).map(Number)
if (level === 'major') [major, minor, patch] = [major + 1, 0, 0]
else if (level === 'minor') [minor, patch] = [minor + 1, 0]
else patch += 1
const next = `${major}.${minor}.${patch}`
writeFileSync(path, text.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))
console.log(next)
