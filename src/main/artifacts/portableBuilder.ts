import { hash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { LRUCache } from 'lru-cache'
import { RUNTIME_MODULES, runtimePackages } from '../../shared/artifacts/artifactRuntime'
import type { PreviewTheme } from '../../shared/artifacts/htmlPreview'
import {
  documentPage,
  PORTABLE_FORMAT,
  PORTABLE_LIMITS,
  type PortableManifest,
  type PortableMode,
  portableType,
  wrapPortable,
} from '../../shared/artifacts/portable'
import {
  BuildFailure,
  BuildRun,
  type Bundler,
  bundle,
  type CompileProblem,
  escapeInlineScript,
  problemText,
} from './portableBundle'
import { buildPage } from './portablePage'
import { PortableTailwind } from './portableTailwind'
import { type PreviewSource, readRegularFile } from './previewFiles'
import type { PreviewBuild } from './previewHostTypes'

const CACHE_MAX = 64
const CACHE_BYTES = 64 * 1024 * 1024
const DEFAULT_TARGET = ['chrome120', 'firefox121']

export type PortableBuild =
  | { ok: true; document: string; file: string; manifest: PortableManifest; inputs: string[] }
  | { ok: false; problems: CompileProblem[]; inputs: string[] }

export interface PortableBuilderDeps {
  load: () => Promise<Bundler>
  runtimeDir: () => string
  version: string
  target?: string[]
  timeoutMs?: number
  cacheBytes?: number
  now?: () => Date
}

interface Cached {
  hashes: Map<string, string>
  result: PortableBuild & { ok: true }
  bytes: number
}

function withFile(
  document: string,
  manifest: PortableManifest,
  inputs: string[],
): PortableBuild & { ok: true } {
  const result = { ok: true as const, document, manifest, inputs }
  Object.defineProperty(result, 'file', {
    enumerable: true,
    get: () => wrapPortable(document, manifest),
  })
  return result as PortableBuild & { ok: true }
}

export function missingRuntimePackages(
  runtimeDir: string,
  packages: readonly string[] = runtimePackages(),
): string[] {
  return packages.filter(
    (name) => !existsSync(join(runtimeDir, RUNTIME_MODULES, name, 'package.json')),
  )
}

export function failedDocument(problems: readonly CompileProblem[], theme: PreviewTheme): string {
  const text = problems.map(problemText).join('\n')
  const script = escapeInlineScript(`throw new Error(${JSON.stringify(text)})`)
  return documentPage('error', `<script type="module">${script}</script>`, '', theme)
}

export class PortableBuilder {
  private readonly cache: LRUCache<string, Cached>
  private readonly tailwind: PortableTailwind
  private readonly target: string[]
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(private readonly deps: PortableBuilderDeps) {
    this.cache = new LRUCache({
      max: CACHE_MAX,
      maxSize: deps.cacheBytes ?? CACHE_BYTES,
      sizeCalculation: (entry) => entry.bytes,
    })
    this.tailwind = new PortableTailwind(deps.runtimeDir)
    this.target = deps.target ?? DEFAULT_TARGET
    this.timeoutMs = deps.timeoutMs ?? PORTABLE_LIMITS.buildMs
    this.now = deps.now ?? (() => new Date())
  }

  async preview(source: PreviewSource, theme: PreviewTheme): Promise<PreviewBuild> {
    const built = await this.build(source, theme, 'development')
    return built.ok
      ? { document: built.document, inputs: built.inputs }
      : { document: failedDocument(built.problems, theme), inputs: built.inputs }
  }

  async build(
    source: PreviewSource,
    theme: PreviewTheme,
    mode: PortableMode,
  ): Promise<PortableBuild> {
    const key = hash('sha256', JSON.stringify([source.file, source.root, theme, mode]))
    const cached = this.cache.get(key)
    if (cached && (await this.unchanged(cached.hashes))) return cached.result
    const run = new BuildRun(source, this.deps.runtimeDir())
    const result = await this.timed(run, () => this.assemble(run, theme, mode))
    if (result.ok) await this.remember(key, run, result)
    return result
  }

  cachedBytes(): number {
    return this.cache.calculatedSize
  }

  private async unchanged(hashes: Map<string, string>): Promise<boolean> {
    for (const [path, expected] of hashes) {
      const found = await readRegularFile(path, PORTABLE_LIMITS.fileBytes)
      if (!found.ok || hash('sha256', found.body) !== expected) return false
    }
    return true
  }

  private async remember(key: string, run: BuildRun, result: PortableBuild & { ok: true }) {
    const hashes = new Map<string, string>()
    for (const path of run.inputs.keys()) {
      const found = await readRegularFile(path, PORTABLE_LIMITS.fileBytes)
      if (!found.ok) return
      hashes.set(path, hash('sha256', found.body))
    }
    const bytes = result.document.length + JSON.stringify(result.manifest).length
    this.cache.set(key, { hashes, result, bytes })
  }

  private async timed(run: BuildRun, work: () => Promise<PortableBuild>): Promise<PortableBuild> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.timeoutMs)
    })
    const failed = (problems: CompileProblem[]): PortableBuild => ({
      ok: false,
      problems,
      inputs: [...run.inputs.keys()],
    })
    try {
      const outcome = await Promise.race([
        work().catch((error: unknown) =>
          failed(
            error instanceof BuildFailure
              ? error.problems
              : [problem(run, error instanceof Error ? error.message : String(error))],
          ),
        ),
        late,
      ])
      if (outcome !== 'late') return outcome
      run.stop()
      return failed([problem(run, 'took over 10 seconds to build')])
    } finally {
      clearTimeout(timer)
    }
  }

  private async assemble(
    run: BuildRun,
    theme: PreviewTheme,
    mode: PortableMode,
  ): Promise<PortableBuild> {
    const type = portableType(run.source.file)
    if (type !== 'component' && type !== 'page') {
      throw new BuildFailure([problem(run, 'is not a page or a component')])
    }
    const missing = missingRuntimePackages(run.runtimeDir)
    if (missing.length > 0) {
      throw new BuildFailure([problem(run, `the preview runtime is missing ${missing.join(', ')}`)])
    }
    let bundler: Bundler
    try {
      bundler = await this.deps.load()
    } catch {
      throw new BuildFailure([problem(run, 'the bundler is not available in this build')])
    }
    const title = basename(run.source.file)
    let document: string
    if (type === 'component') {
      const out = await bundle(bundler, run, { kind: 'component' }, mode, this.target)
      const tailwind = await this.tailwind.css(
        'component',
        run.sources.values(),
        run.stopping.signal,
      )
      const css = [tailwind, out.css].filter(Boolean).join('\n')
      document = documentPage(
        title,
        `<div id="root"></div>\n<script type="module">${out.js}</script>`,
        css,
        theme,
      )
    } else {
      const page = await buildPage(bundler, run, mode, this.target, (texts) =>
        this.tailwind.css('page', texts, run.stopping.signal),
      )
      document = page.html
    }
    const manifest: PortableManifest = {
      format: PORTABLE_FORMAT,
      type,
      name: title,
      built: this.now().toISOString(),
      ostia: this.deps.version,
      libraries: [...run.libraries].sort(),
      theme,
      hash: hash('sha256', document),
      sources: Object.fromEntries(run.sources),
    }
    const built = withFile(document, manifest, [...run.inputs.keys()])
    if (Buffer.byteLength(built.file) > PORTABLE_LIMITS.fileBytes) throw run.tooLarge()
    return built
  }
}

function problem(run: BuildRun, message: string): CompileProblem {
  return { file: run.label(run.source.file), line: 1, column: 1, message }
}
