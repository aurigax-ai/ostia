import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let commit = null
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  if (dirty) commit += '-dirty'
} catch {}

const info = { version, commit, builtAt: new Date().toISOString() }
mkdirSync(join(root, 'out'), { recursive: true })
writeFileSync(join(root, 'out', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
console.log(`build ${version}${commit ? ` (${commit})` : ''}`)
