import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVersion } from './buildVersion.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version: base } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

function gitState() {
  try {
    return {
      tags: git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean),
      commit: git('rev-parse', '--short=6', 'HEAD'),
      dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
    }
  } catch {
    return null
  }
}

const version = buildVersion(base, gitState())
const info = { version, builtAt: new Date().toISOString() }
mkdirSync(join(root, 'out'), { recursive: true })
writeFileSync(join(root, 'out', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
console.log(`build ${version}`)
