import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererDir = resolve(__dirname, '..')
const setupSource = readFileSync(resolve(__dirname, 'setup.ts'), 'utf8')
const monacoRoot = resolve(__dirname, '../../../node_modules/monaco-editor')
const definitionsDir = join(monacoRoot, 'esm/vs/languages/definitions')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

describe('monaco setup imports', () => {
  it('loads every monaco module through the package name so dev and build share one instance', () => {
    const offenders = sourceFiles(rendererDir).filter((file) =>
      /node_modules\/monaco-editor|import\.meta\.glob\([^)]*monaco/.test(
        readFileSync(file, 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })

  it('registers the language definitions from the package entry', () => {
    expect(setupSource).toContain("import 'monaco-editor/languages/definitions/register.all.js'")
  })

  it('the package entry registers every bundled language definition', () => {
    const entry = readFileSync(join(definitionsDir, 'register.all.js'), 'utf8')
    const registered = [...entry.matchAll(/import '\.\/([^/]+)\/register\.js'/g)].map((m) => m[1])
    const available = readdirSync(definitionsDir).filter((name) =>
      statSync(join(definitionsDir, name)).isDirectory(),
    )
    expect(available.length).toBeGreaterThan(50)
    expect([...registered].sort()).toEqual([...available].sort())
  })
})
