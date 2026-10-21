import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../..')
const NAMES =
  /@aurigax-ai\/screens|aurigax-ai\/screens|SCREENS_TOKEN|\bscreens (mcp|daemon|create|list|stop)\b|ostia screen\b|extensions\/screens\b|["']screens["']/
const ALLOWED = [
  /^src\/extensions\/screens\//,
  /^extensions\/screens\//,
  /^test\/fixtures\/tools\/bin\/screens$/,
  /^(marketplace\/)?ostia-marketplace\.json$/,
  /^marketplace\/README\.md$/,
  /^packages\/extension-sdk\/docs\/EXTENSIONS\.md$/,
  /^e2e\/screens-panel\.spec\.ts$/,
  /^e2e\/editor-scroll\.bench\.ts$/,
  /^test\/e2eAreas\/screens\.json$/,
  ...(existsSync(join(root, 'src/main')) ? [] : [/^README\.md$/]),
]
const SKIPPED = new Set(['node_modules', '.git', 'out', 'dist'])

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [relative(root, path)] : []
  })
}

function treeFiles(): string[] {
  try {
    const listed = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\n')
      .filter(Boolean)
    if (listed.length > 0) return listed
  } catch {}
  return walk(root)
}

describe('the screens extension stays out of core', () => {
  it('SCX-C1 no file outside the extension, its marketplace entry, its tool fake, its e2e spec and the SDK docs names the screens service', () => {
    const files = treeFiles()
    expect(files).toContain('src/extensions/screens/ostia.json')
    const naming = files.filter((file) => {
      if (ALLOWED.some((pattern) => pattern.test(file))) return false
      const path = join(root, file)
      if (!existsSync(path)) return false
      const text = readFileSync(path)
      return !text.includes(0) && NAMES.test(text.toString('utf8'))
    })
    expect(naming).toEqual([])
  })
})
