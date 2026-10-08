import { createHash } from 'node:crypto'
import { extname } from 'node:path'

export const COMPILE_MAX_BYTES = 1024 * 1024
export const COMPILE_TIMEOUT_MS = 5_000
const CACHE_MAX = 64
const LOADERS: Readonly<Record<string, 'jsx' | 'tsx' | 'ts'>> = {
  '.jsx': 'jsx',
  '.tsx': 'tsx',
  '.ts': 'ts',
}

export interface CompileProblem {
  file: string
  line: number
  column: number
  message: string
}

export interface Transformer {
  transform: (source: string, options: Record<string, unknown>) => Promise<{ code: string }>
  stop?: () => void | Promise<void>
}

export function compiles(path: string): boolean {
  return extname(path).toLowerCase() in LOADERS
}

export function problemText(problem: CompileProblem): string {
  return `${problem.file}:${problem.line}:${problem.column}: ${problem.message}`
}

export function reportingModule(problems: readonly CompileProblem[]): string {
  const text = problems.map(problemText).join('\n')
  return `throw new Error(${JSON.stringify(text)})\n`
}

interface TransformFailure {
  errors?: { text?: string; location?: { line?: number; column?: number } | null }[]
}

function problemsOf(error: unknown, file: string): CompileProblem[] {
  const failures = (error as TransformFailure | null)?.errors
  if (!Array.isArray(failures) || failures.length === 0) {
    return [
      { file, line: 1, column: 1, message: error instanceof Error ? error.message : String(error) },
    ]
  }
  return failures.map((failure) => ({
    file,
    line: failure.location?.line ?? 1,
    column: (failure.location?.column ?? 0) + 1,
    message: failure.text ?? 'does not compile',
  }))
}

export class ArtifactCompiler {
  private readonly cache = new Map<string, string>()

  constructor(
    private readonly load: () => Promise<Transformer>,
    private readonly target: string,
    private readonly timeoutMs: number = COMPILE_TIMEOUT_MS,
  ) {}

  async compile(file: string, source: Buffer): Promise<string> {
    const loader = LOADERS[extname(file).toLowerCase()]
    if (!loader) throw new Error(`${file} is not compiled`)
    if (source.length > COMPILE_MAX_BYTES) {
      return reportingModule([
        { file, line: 1, column: 1, message: 'is over 1 MiB, the most a preview compiles' },
      ])
    }
    const key = createHash('sha256').update(loader).update('\0').update(source).digest('hex')
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const code = await this.transform(file, source.toString('utf8'), loader)
    this.cache.set(key, code)
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return code
  }

  private async transform(file: string, source: string, loader: string): Promise<string> {
    let transformer: Transformer
    try {
      transformer = await this.load()
    } catch {
      return reportingModule([
        { file, line: 1, column: 1, message: 'the compiler is not available in this build' },
      ])
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.timeoutMs)
    })
    try {
      const result = await Promise.race([
        transformer.transform(source, {
          loader,
          format: 'esm',
          jsx: 'automatic',
          sourcemap: 'inline',
          sourcefile: file,
          target: this.target,
          logLevel: 'silent',
        }),
        late,
      ])
      if (result === 'late') {
        void transformer.stop?.()
        return reportingModule([
          { file, line: 1, column: 1, message: 'took over 5 seconds to compile' },
        ])
      }
      return result.code
    } catch (error) {
      return reportingModule(problemsOf(error, file))
    } finally {
      clearTimeout(timer)
    }
  }
}
