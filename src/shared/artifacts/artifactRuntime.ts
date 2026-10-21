export interface RuntimeModule {
  specifier: string
  package: string
  about: string
  entry?: string
}

export const ARTIFACT_RUNTIME: readonly RuntimeModule[] = [
  { specifier: 'react', package: 'react', about: 'React 18' },
  {
    specifier: 'react/jsx-runtime',
    package: 'react',
    about: 'the JSX runtime (used by compiled .jsx/.tsx; never import it yourself)',
  },
  { specifier: 'react-dom', package: 'react-dom', about: 'React DOM' },
  { specifier: 'react-dom/client', package: 'react-dom', about: 'createRoot' },
  { specifier: 'recharts', package: 'recharts', about: 'charts' },
  { specifier: 'lucide-react', package: 'lucide-react', about: 'icons' },
  { specifier: '@phosphor-icons/react', package: '@phosphor-icons/react', about: 'icons' },
  { specifier: 'd3', package: 'd3', about: 'data visualisation' },
  { specifier: 'papaparse', package: 'papaparse', about: 'CSV parsing' },
  {
    specifier: 'sql.js',
    package: 'sql.js',
    entry: 'sql.js/dist/sql-asm.js',
    about: 'SQLite, asm.js build (no WASM)',
  },
]

export const TAILWIND_PACKAGE = 'tailwindcss'
export const RUNTIME_MODULES = 'node_modules'
export const RUNTIME_NOTICES = 'THIRD-PARTY-NOTICES.txt'

export function runtimePackages(): string[] {
  return [...new Set([...ARTIFACT_RUNTIME.map((module) => module.package), TAILWIND_PACKAGE])]
}

export function allowsRuntimeImport(specifier: string): boolean {
  return ARTIFACT_RUNTIME.some((module) => module.specifier === specifier)
}

export function runtimeEntry(specifier: string): string {
  return ARTIFACT_RUNTIME.find((module) => module.specifier === specifier)?.entry ?? specifier
}

export function importableSpecifiers(): string[] {
  return ARTIFACT_RUNTIME.filter((module) => module.specifier !== 'react/jsx-runtime').map(
    (module) => module.specifier,
  )
}
