import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_RUNTIME,
  RUNTIME_NOTICES,
  TAILWIND_RUNTIME,
  importableSpecifiers,
  runtimeFiles,
  runtimeHelp,
  runtimeImportMap,
} from './artifactRuntime'

const built = join(process.cwd(), 'out', 'artifact-runtime')
const skill = readFileSync(join(process.cwd(), 'src/main/agent/ostia-skill.md'), 'utf8')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the preview runtime', () => {
  it('is the approved set: React, recharts, lucide, Phosphor, d3, papaparse and Tailwind', () => {
    expect(ARTIFACT_RUNTIME.map((module) => module.specifier)).toEqual([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      'recharts',
      'lucide-react',
      '@phosphor-icons/react',
      'd3',
      'papaparse',
    ])
    expect(TAILWIND_RUNTIME.package).toBe('@tailwindcss/browser')
    expect(manifest.devDependencies.react).toBe('^18.3.1')
  })

  it('maps every specifier to its own local file and nothing remote', () => {
    const { imports } = runtimeImportMap()
    expect(Object.keys(imports)).toEqual(ARTIFACT_RUNTIME.map((module) => module.specifier))
    for (const module of ARTIFACT_RUNTIME) {
      expect(imports[module.specifier]).toBe(`/runtime/${module.file}`)
    }
    expect(new Set(runtimeFiles()).size).toBe(runtimeFiles().length)
    expect(JSON.stringify(imports)).not.toMatch(/https?:|\/\//)
  })

  it('is built: one file per entry, sharing one React, with the licence notices', () => {
    for (const file of runtimeFiles()) {
      expect(existsSync(join(built, file)), file).toBe(true)
      expect(statSync(join(built, file)).size, file).toBeGreaterThan(200)
    }
    for (const module of ARTIFACT_RUNTIME) {
      const code = readFileSync(join(built, module.file), 'utf8')
      const imported = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1])
      expect([...new Set(imported)].sort(), module.file).toEqual(
        [...module.external].filter((name) => imported.includes(name)).sort(),
      )
      expect(code, module.file).not.toMatch(/https?:\/\/(cdn|unpkg|esm\.sh|cdnjs)/)
    }
    const react = readFileSync(join(built, 'react.js'), 'utf8')
    expect(react).not.toMatch(/^import /m)
    const recharts = readFileSync(join(built, 'recharts.js'), 'utf8')
    expect(recharts).toContain('from "react"')
    expect(recharts).not.toContain('react.development.js')
    const notices = readFileSync(join(built, RUNTIME_NOTICES), 'utf8')
    for (const name of ['react ', 'recharts ', 'lucide-react ', 'd3 ', 'papaparse ']) {
      expect(notices, name).toContain(name)
    }
  })

  it('is what the skill and ostia docs tell agents they can import', () => {
    const help = runtimeHelp()
    for (const specifier of importableSpecifiers()) {
      expect(help, specifier).toContain(specifier)
      expect(skill, specifier).toMatch(
        new RegExp(`^${specifier.replace(/[/@.-]/g, '\\$&')}\\s`, 'm'),
      )
    }
    expect(help).toContain('/runtime/tailwind.js')
    expect(skill).toContain('/runtime/tailwind.js')
    expect(importableSpecifiers()).not.toContain('react/jsx-runtime')
  })

  it('ships the compiler as a dependency and the libraries only as build inputs', () => {
    expect(manifest.dependencies.esbuild).toBeDefined()
    expect(manifest.devDependencies.esbuild).toBeUndefined()
    for (const name of ['recharts', 'lucide-react', 'd3', 'papaparse', '@tailwindcss/browser']) {
      expect(manifest.devDependencies[name], name).toBeDefined()
      expect(manifest.dependencies[name], name).toBeUndefined()
    }
  })
})
