import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const source = 'out/marketplace'
const kept = ['.git', 'node_modules', 'pnpm-lock.yaml']
const checkout = process.argv[2] ? resolve(process.argv[2]) : null

if (!checkout || !existsSync(join(checkout, '.git'))) {
  console.error('usage: pnpm publish:marketplace <checkout of the marketplace repository>')
  process.exit(1)
}

for (const name of readdirSync(checkout).filter((name) => !kept.includes(name))) {
  rmSync(join(checkout, name), { recursive: true, force: true })
}
cpSync(source, checkout, {
  recursive: true,
  filter: (path) => basename(path) !== 'node_modules',
})
for (const step of [['install', '--no-frozen-lockfile'], ['build']]) {
  execFileSync('pnpm', step, { cwd: checkout, stdio: 'inherit' })
}
console.log(`copied ${source} to ${checkout}: review, commit and push it there`)
