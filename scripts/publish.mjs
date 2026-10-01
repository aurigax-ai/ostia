import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const targets = {
  marketplace: {
    source: 'out/marketplace',
    marker: 'pine-marketplace.json',
    replace: ['extensions', 'src'],
  },
  sdk: { source: 'out/sdk', marker: 'package.json', replace: null },
}

const [kind, checkout] = process.argv.slice(2)
const target = targets[kind]
const dir = checkout ? resolve(checkout) : null

if (!target || !dir || !existsSync(join(dir, '.git'))) {
  console.error('usage: node scripts/publish.mjs <marketplace|sdk> <checkout of its repository>')
  process.exit(1)
}
if (!existsSync(join(target.source, target.marker))) {
  console.error(`${target.source} is missing: build it first`)
  process.exit(1)
}

const stale = target.replace ?? readdirSync(dir).filter((name) => name !== '.git')
for (const name of stale) rmSync(join(dir, name), { recursive: true, force: true })
cpSync(target.source, dir, { recursive: true })
console.log(`copied ${target.source} to ${dir}: review, commit and push it there`)
