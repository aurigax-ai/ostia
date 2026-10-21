import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_RUNTIME,
  allowsRuntimeImport,
  importableSpecifiers,
  RUNTIME_MODULES,
  RUNTIME_NOTICES,
  runtimeEntry,
  runtimePackages,
  TAILWIND_PACKAGE,
} from './artifactRuntime'

const built = join(process.cwd(), 'out', 'artifact-runtime')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the preview runtime', () => {
  it('is the approved set: React, recharts, lucide, Phosphor, d3, papaparse, sql.js and Tailwind', () => {
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
      'sql.js',
    ])
    expect(TAILWIND_PACKAGE).toBe('tailwindcss')
    expect(manifest.devDependencies.react).toBe('^18.3.1')
  })

  it('allows only the listed specifiers, exactly', () => {
    for (const specifier of [...importableSpecifiers(), 'react/jsx-runtime']) {
      expect(allowsRuntimeImport(specifier), specifier).toBe(true)
    }
    for (const specifier of [
      'lodash',
      'react-dom/server',
      'd3-scale',
      '/runtime/react.js',
      'tailwindcss',
    ]) {
      expect(allowsRuntimeImport(specifier), specifier).toBe(false)
    }
  })

  it('runs sql.js as its asm build, never the WASM one', () => {
    expect(runtimeEntry('sql.js')).toBe('sql.js/dist/sql-asm.js')
    expect(runtimeEntry('d3')).toBe('d3')
    expect(allowsRuntimeImport('sql.js')).toBe(true)
    expect(allowsRuntimeImport('sql.js/dist/sql-wasm.js')).toBe(false)
    expect(existsSync(join(built, RUNTIME_MODULES, 'sql.js', 'dist', 'sql-asm.js'))).toBe(true)
    expect(existsSync(join(built, RUNTIME_MODULES, 'sql.js', 'dist', 'sql-wasm.wasm'))).toBe(false)
  })

  it('is built as a package tree with the licence notices and no whole-library files', () => {
    for (const name of runtimePackages()) {
      expect(existsSync(join(built, RUNTIME_MODULES, name, 'package.json')), name).toBe(true)
    }
    expect(existsSync(join(built, 'react.js'))).toBe(false)
    expect(existsSync(join(built, 'tailwind.js'))).toBe(false)
    const notices = readFileSync(join(built, RUNTIME_NOTICES), 'utf8')
    for (const name of [
      'react ',
      'recharts ',
      'lucide-react ',
      'd3 ',
      'papaparse ',
      'sql.js ',
      'tailwindcss ',
    ]) {
      expect(notices, name).toContain(name)
    }
  })

  it('ships the bundler as a dependency and the libraries only as build inputs', () => {
    expect(manifest.dependencies.esbuild).toBeDefined()
    expect(manifest.devDependencies.esbuild).toBeUndefined()
    for (const name of ['recharts', 'lucide-react', 'd3', 'papaparse', 'sql.js', 'tailwindcss']) {
      expect(manifest.devDependencies[name], name).toBeDefined()
      expect(manifest.dependencies[name], name).toBeUndefined()
    }
    expect(manifest.devDependencies['@tailwindcss/browser']).toBeUndefined()
  })
})
