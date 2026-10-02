import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../..')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}
const dependencies = Object.keys(manifest.dependencies)

const UNBUNDLED_ROOTS = ['src/main', 'src/preload', 'src/cli', 'src/shared']
const RUNTIME_PROVIDED = new Set(['electron'])
const RENDERER_ONLY = [
  'monaco-editor',
  '@phosphor-icons/react',
  '@base-ui/react',
  '@xterm/xterm',
  'react',
  'react-dom',
  'ai',
  'zustand',
]

const SPECIFIER = /(?:from\s+|import\s+|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    const isSource = /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)
    return isSource ? [path] : []
  })
}

function packageOf(specifier: string): string | null {
  const bare = !/^(\.|\/|node:|@\/|@shared\/)/.test(specifier)
  if (!bare) return null
  const [first, second] = specifier.split('/')
  const name = first.startsWith('@') ? `${first}/${second}` : first
  return builtinModules.includes(name) ? null : name
}

function barePackages(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(SPECIFIER)) {
    const name = packageOf(match[1])
    if (name) found.add(name)
  }
  return found
}

function bundledIntoMain(): string[] {
  const config = readFileSync(join(repoRoot, 'electron.vite.config.ts'), 'utf8')
  const block = /exclude:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

describe('dependency sections', () => {
  it('lists every package that unbundled code requires in dependencies', () => {
    const bundled = new Set(bundledIntoMain())
    const required = new Set<string>()
    for (const root of UNBUNDLED_ROOTS) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        for (const name of barePackages(readFileSync(file, 'utf8'))) required.add(name)
      }
    }
    expect(required).toContain('ws')
    const missing = [...required].filter(
      (name) => !dependencies.includes(name) && !RUNTIME_PROVIDED.has(name) && !bundled.has(name),
    )
    expect(missing).toEqual([])
  })

  it('lists every package the built CLI requires in dependencies', () => {
    const built = readFileSync(join(repoRoot, 'out/cli/index.js'), 'utf8')
    const required = [...barePackages(built)]
    expect(required).toContain('commander')
    expect(required.filter((name) => !dependencies.includes(name))).toEqual([])
  })

  it('keeps packages only bundled code uses out of dependencies', () => {
    expect(RENDERER_ONLY.filter((name) => dependencies.includes(name))).toEqual([])
  })
})
