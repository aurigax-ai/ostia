import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
    expect(manifest.devDependencies.react).toBe('^19.3.1')
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
    expect(runtimeEntry('sql.js')).toBe('sql.js/dist/sql-asm-memory-growth.js')
    expect(runtimeEntry('d3')).toBe('d3')
    expect(allowsRuntimeImport('sql.js')).toBe(true)
    expect(allowsRuntimeImport('sql.js/dist/sql-wasm.js')).toBe(false)
    expect(
      existsSync(join(built, RUNTIME_MODULES, 'sql.js', 'dist', 'sql-asm-memory-growth.js')),
    ).toBe(true)
    expect(existsSync(join(built, RUNTIME_MODULES, 'sql.js', 'dist', 'sql-wasm.wasm'))).toBe(false)
  })

  it('groups a seed of several MiB with the shipped sql.js build', async () => {
    const dist = join(built, RUNTIME_MODULES, 'sql.js', 'dist')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const init = createRequire(join(dist, 'x.js'))('./sql-asm-memory-growth.js') as () => Promise<{
      Database: new (
        bytes?: Uint8Array,
      ) => {
        run: (sql: string) => void
        export: () => Uint8Array
        exec: (sql: string) => { values: unknown[][] }[]
      }
    }>
    const SQL = await init()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the asm.js build is deprecated'))
    warn.mockRestore()
    const source = new SQL.Database()
    source.run('create table t(k integer, v text)')
    source.run(
      "with recursive n(i) as (select 1 union all select i + 1 from n where i < 150000) insert into t select i % 50000, printf('%020d', i) from n",
    )
    const seed = source.export()
    expect(seed.length).toBeGreaterThan(2 * 1024 * 1024)
    expect(seed.length).toBeLessThan(8 * 1024 * 1024)
    const grouped = new SQL.Database(seed).exec(
      'select count(*), sum(c) from (select k, count(*) c from t group by k order by count(*) desc, k)',
    )
    expect(grouped[0].values[0]).toEqual([50000, 150000])
  }, 120_000)

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
