import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const LEVELS = ['patch', 'minor', 'major']
const level = process.argv[2]
if (!LEVELS.includes(level)) {
  console.error(`usage: pnpm bump <${LEVELS.join('|')}>`)
  process.exit(1)
}

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const text = readFileSync(path, 'utf8')
const pkg = JSON.parse(text)
const next = semver.inc(pkg.version, level)
if (!next) {
  console.error(`package.json version is not semver: ${pkg.version}`)
  process.exit(1)
}
writeFileSync(path, text.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))
console.log(next)
