import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const stem = (file) => file.replace(/\.[^./]*$/, '')

export function caseClashes(files) {
  const byLower = new Map()
  for (const file of files) {
    const key = stem(file).toLowerCase()
    byLower.set(key, [...(byLower.get(key) ?? []), file])
  }
  return [...byLower.values()].filter((group) => new Set(group.map(stem)).size > 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
  const clashes = caseClashes(files)
  for (const group of clashes) console.error(`paths differ only in case: ${group.join(' | ')}`)
  if (clashes.length > 0) process.exit(1)
}
