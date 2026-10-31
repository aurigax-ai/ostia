import { execFileSync } from 'node:child_process'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean)

const stem = (file) => file.replace(/\.[^./]*$/, '')

const byLower = new Map()
for (const file of files) {
  const key = stem(file).toLowerCase()
  byLower.set(key, [...(byLower.get(key) ?? []), file])
}

const clashes = [...byLower.values()].filter((group) => new Set(group.map(stem)).size > 1)
if (clashes.length > 0) {
  for (const group of clashes) console.error(`paths differ only in case: ${group.join(' | ')}`)
  process.exit(1)
}
