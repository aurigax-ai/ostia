export interface RuntimeModule {
  specifier: string
  file: string
  package: string
  external: readonly string[]
  about: string
}

const REACT = ['react']
const REACT_ALL = ['react', 'react-dom', 'react/jsx-runtime']

export const ARTIFACT_RUNTIME: readonly RuntimeModule[] = [
  { specifier: 'react', file: 'react.js', package: 'react', external: [], about: 'React 18' },
  {
    specifier: 'react/jsx-runtime',
    file: 'react-jsx.js',
    package: 'react',
    external: REACT,
    about: 'the JSX runtime (used by compiled .jsx/.tsx; never import it yourself)',
  },
  {
    specifier: 'react-dom',
    file: 'react-dom.js',
    package: 'react-dom',
    external: REACT,
    about: 'React DOM',
  },
  {
    specifier: 'react-dom/client',
    file: 'react-dom-client.js',
    package: 'react-dom',
    external: ['react', 'react-dom'],
    about: 'createRoot',
  },
  {
    specifier: 'recharts',
    file: 'recharts.js',
    package: 'recharts',
    external: REACT_ALL,
    about: 'charts',
  },
  {
    specifier: 'lucide-react',
    file: 'lucide-react.js',
    package: 'lucide-react',
    external: REACT_ALL,
    about: 'icons',
  },
  {
    specifier: '@phosphor-icons/react',
    file: 'phosphor.js',
    package: '@phosphor-icons/react',
    external: REACT_ALL,
    about: 'icons',
  },
  { specifier: 'd3', file: 'd3.js', package: 'd3', external: [], about: 'data visualisation' },
  {
    specifier: 'papaparse',
    file: 'papaparse.js',
    package: 'papaparse',
    external: [],
    about: 'CSV parsing',
  },
]

export const TAILWIND_RUNTIME = {
  file: 'tailwind.js',
  package: '@tailwindcss/browser',
  about: 'Tailwind CSS utility classes, built in the page',
} as const

export const RUNTIME_PREFIX = '/runtime/'
export const RUNTIME_NOTICES = 'THIRD-PARTY-NOTICES.txt'

export function runtimeFiles(): string[] {
  return [...ARTIFACT_RUNTIME.map((module) => module.file), TAILWIND_RUNTIME.file]
}

export function runtimeImportMap(): { imports: Record<string, string> } {
  return {
    imports: Object.fromEntries(
      ARTIFACT_RUNTIME.map((module) => [module.specifier, `${RUNTIME_PREFIX}${module.file}`]),
    ),
  }
}

export function importableSpecifiers(): string[] {
  return ARTIFACT_RUNTIME.filter((module) => module.specifier !== 'react/jsx-runtime').map(
    (module) => module.specifier,
  )
}

export function runtimeHelp(): string {
  const libraries = ARTIFACT_RUNTIME.filter((module) => module.specifier !== 'react/jsx-runtime')
    .map((module) => `  ${module.specifier.padEnd(24)} ${module.about}`)
    .join('\n')
  return [
    'Libraries a preview can import (bundled, no network; anything else fails to resolve):',
    libraries,
    `  ${`<script src="${RUNTIME_PREFIX}${TAILWIND_RUNTIME.file}">`.padEnd(24)} ${TAILWIND_RUNTIME.about}`,
    `An .html page loads them by path in a module script, for example ${RUNTIME_PREFIX}recharts.js`,
  ].join('\n')
}
