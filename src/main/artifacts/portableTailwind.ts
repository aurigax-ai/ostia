import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { RUNTIME_MODULES, TAILWIND_PACKAGE } from '../../shared/artifacts/artifactRuntime'

interface TailwindCompiler {
  build: (candidates: string[]) => string
}

interface TailwindModule {
  compile: (
    css: string,
    options: {
      base: string
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ path: string; base: string; content: string }>
    },
  ) => Promise<TailwindCompiler>
}

const DARK_BY_CLASS = '@custom-variant dark (&:where(.dark, .dark *));'
const AT_IMPORT = '@import'
const WITH_PREFLIGHT = `${AT_IMPORT} "${TAILWIND_PACKAGE}";\n${DARK_BY_CLASS}`
const WITHOUT_PREFLIGHT = [
  `${AT_IMPORT} "${TAILWIND_PACKAGE}/theme.css" layer(theme);`,
  `${AT_IMPORT} "${TAILWIND_PACKAGE}/utilities.css" layer(utilities);`,
  DARK_BY_CLASS,
].join('\n')
const CANDIDATE = /[^\s"'`<>={};\\]+/g

export type TailwindStyle = 'component' | 'page'

export function classCandidates(texts: Iterable<string>): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(CANDIDATE)) found.add(match[0])
  }
  return [...found]
}

export class PortableTailwind {
  constructor(private readonly runtimeDir: () => string) {}

  private compiler(style: TailwindStyle): Promise<TailwindCompiler> {
    const tree = join(this.runtimeDir(), RUNTIME_MODULES)
    const packageDir = join(tree, TAILWIND_PACKAGE)
    const required = createRequire(join(this.runtimeDir(), 'package.json'))
    const tailwind = required(TAILWIND_PACKAGE) as TailwindModule
    return tailwind.compile(style === 'component' ? WITH_PREFLIGHT : WITHOUT_PREFLIGHT, {
      base: packageDir,
      loadStylesheet: async (id, base) => {
        const path = id.startsWith(TAILWIND_PACKAGE)
          ? join(tree, id === TAILWIND_PACKAGE ? `${TAILWIND_PACKAGE}/index.css` : id)
          : resolve(base, id)
        if (!path.startsWith(`${packageDir}/`)) throw new Error(`no stylesheet ${id}`)
        return { path, base: dirname(path), content: await readFile(path, 'utf8') }
      },
    })
  }

  async css(style: TailwindStyle, texts: Iterable<string>): Promise<string> {
    const css = (await this.compiler(style)).build(classCandidates(texts))
    if (style === 'page' && css === (await this.compiler(style)).build([])) return ''
    return css
  }
}
