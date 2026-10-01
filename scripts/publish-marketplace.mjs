import { cpSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const source = 'out/marketplace'
const target = process.argv[2] ? resolve(process.argv[2]) : null

if (!target || !existsSync(join(target, '.git'))) {
  console.error('usage: pnpm publish:marketplace <checkout of the marketplace repository>')
  process.exit(1)
}
if (!existsSync(join(source, 'pine-marketplace.json'))) {
  console.error('out/marketplace is missing: run pnpm build:extensions first')
  process.exit(1)
}

rmSync(join(target, 'extensions'), { recursive: true, force: true })
cpSync(source, target, { recursive: true })
console.log(`copied ${source} to ${target}: review, commit and push it there`)
