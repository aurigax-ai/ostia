import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type {
  BuildOptions,
  BuildResult,
  Loader,
  OnResolveArgs,
  OnResolveResult,
  Plugin,
  PluginBuild,
} from 'esbuild'
import {
  allowsRuntimeImport,
  importableSpecifiers,
  RUNTIME_MODULES,
} from '../../shared/artifacts/artifactRuntime'
import { PORTABLE_LIMITS, type PortableMode } from '../../shared/artifacts/portable'
import { isInsidePath } from '../platform/pathGuard'
import { type PreviewSource, readRegularFile, resolvePreviewFile } from './previewFiles'
import shellSource from './previewShellModule.txt?raw'

export interface BundleContext {
  rebuild: () => Promise<BuildResult>
  cancel: () => Promise<void>
  dispose: () => Promise<void>
}

export interface Bundler {
  context: (options: BuildOptions & { write: false }) => Promise<BundleContext>
  stop?: () => void | Promise<void>
}

export interface CompileProblem {
  file: string
  line: number
  column: number
  message: string
}

export class BuildFailure extends Error {
  constructor(readonly problems: CompileProblem[]) {
    super(problems.map(problemText).join('\n'))
  }
}

export function problemText(problem: CompileProblem): string {
  return `${problem.file}:${problem.line}:${problem.column}: ${problem.message}`
}

const CODE_LOADERS: Readonly<Record<string, Loader>> = {
  '.js': 'js',
  '.mjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.css': 'css',
  '.json': 'json',
  '.csv': 'text',
  '.tsv': 'text',
  '.txt': 'text',
  '.md': 'text',
}

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
])

const GUESSED = ['.tsx', '.ts', '.jsx', '.js']
const ARTIFACT = 'artifact'
const SHELL = 'ostia-shell'
const INLINE = 'ostia-inline'
const RUNTIME_DATA = { runtime: true }

function isTextInput(path: string): boolean {
  return extname(path).toLowerCase() in CODE_LOADERS || /\.html?$/i.test(path)
}

function loaderFor(path: string): Loader | null {
  const extension = extname(path).toLowerCase()
  if (extension in CODE_LOADERS) return CODE_LOADERS[extension]
  return ASSET_EXTENSIONS.has(extension) ? 'dataurl' : null
}

export interface InputRecord {
  path: string
  bytes: number
}

export class BuildRun {
  readonly inputs = new Map<string, InputRecord>()
  readonly sources = new Map<string, string>()
  readonly libraries = new Set<string>()
  readonly stopping = new AbortController()
  private readonly contexts = new Set<BundleContext>()
  private sourceBytes = 0
  private inputBytes = 0

  constructor(
    readonly source: PreviewSource,
    readonly runtimeDir: string,
  ) {}

  hold(context: BundleContext): () => void {
    this.contexts.add(context)
    if (this.stopping.signal.aborted) void context.cancel()
    return () => this.contexts.delete(context)
  }

  stop(): void {
    this.stopping.abort()
    for (const context of this.contexts) void context.cancel().catch(() => {})
  }

  label(path: string): string {
    const base = dirname(this.source.file)
    return isInsidePath(base, path) ? relative(base, path).split(sep).join('/') : path
  }

  async read(path: string): Promise<Buffer> {
    const text = isTextInput(path)
    const limit = text ? PORTABLE_LIMITS.sourceFileBytes : PORTABLE_LIMITS.fileBytes
    const found = await readRegularFile(path, limit)
    if (!found.ok) {
      throw new BuildFailure([
        {
          file: this.label(path),
          line: 1,
          column: 1,
          message:
            found.status === 413
              ? `is over ${text ? '1 MiB, the most a source file may be' : '16 MiB'}`
              : 'is not a regular file inside the artifact folder',
        },
      ])
    }
    this.inputBytes += found.body.length
    if (text) this.sourceBytes += found.body.length
    if (!this.inputs.has(path)) this.inputs.set(path, { path, bytes: found.body.length })
    if (text) this.sources.set(this.label(path), found.body.toString('utf8'))
    if (this.sourceBytes > PORTABLE_LIMITS.sourceBytes) {
      throw new BuildFailure([
        { file: this.label(path), line: 1, column: 1, message: 'sources are over 4 MiB in total' },
      ])
    }
    if (this.inputBytes > PORTABLE_LIMITS.fileBytes) throw this.tooLarge()
    return found.body
  }

  tooLarge(): BuildFailure {
    const largest = [...this.inputs.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3)
      .map((input) => `${this.label(input.path)} (${mebibytes(input.bytes)})`)
      .join(', ')
    return new BuildFailure([
      {
        file: this.label(this.source.file),
        line: 1,
        column: 1,
        message: `the portable file would be over the 16 MiB limit; largest inputs: ${largest}`,
      },
    ])
  }

  resolveLocal(path: string, importer: string): string | null {
    if (path.includes('\0')) return null
    const wanted = isAbsolute(path) ? null : join(dirname(importer), path)
    if (!wanted) return null
    const candidates = extname(wanted) ? [wanted] : [wanted, ...GUESSED.map((e) => wanted + e)]
    for (const candidate of candidates) {
      const found = this.resolveInside(candidate)
      if (found) return found
    }
    return null
  }

  private resolveInside(path: string): string | null {
    if (path === this.source.file) return path
    if (!this.source.root) return null
    const found = resolvePreviewFile(this.source, `/${relative(this.source.root, path)}`)
    return found.ok ? found.path : null
  }

  noteLibrary(resolved: string): void {
    const tree = join(this.runtimeDir, RUNTIME_MODULES)
    if (!isInsidePath(tree, resolved)) return
    const inside = relative(tree, resolved).split(sep)
    const name = inside[0]?.startsWith('@') ? `${inside[0]}/${inside[1]}` : inside[0]
    if (!name) return
    try {
      const info = JSON.parse(readFileSync(join(tree, name, 'package.json'), 'utf8')) as {
        version?: string
      }
      this.libraries.add(`${name}@${info.version ?? 'unknown'}`)
    } catch {
      this.libraries.add(name)
    }
  }
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function isRemote(path: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)
}

function isRelative(path: string): boolean {
  return path.startsWith('./') || path.startsWith('../')
}

function notAllowed(specifier: string): string {
  return `cannot import ${JSON.stringify(specifier)}; an artifact can import only ${importableSpecifiers().join(', ')} and files beside it`
}

function artifactPlugin(run: BuildRun, entry: ArtifactEntry): Plugin {
  const tree = join(run.runtimeDir, RUNTIME_MODULES)
  const insideTree = (path: string): boolean => isInsidePath(tree, path)

  const insideRuntime = async (
    build: PluginBuild,
    args: OnResolveArgs,
  ): Promise<OnResolveResult> => {
    const found = await build.resolve(args.path, {
      kind: args.kind,
      resolveDir: args.resolveDir,
      pluginData: RUNTIME_DATA,
    })
    if (found.errors.length > 0) return { errors: found.errors }
    if (!found.external && !insideTree(found.path)) {
      return { errors: [{ text: `the preview runtime has no ${JSON.stringify(args.path)}` }] }
    }
    return { path: found.path, external: found.external, sideEffects: found.sideEffects }
  }

  const library = async (build: PluginBuild, args: OnResolveArgs) => {
    const found = await build.resolve(args.path, {
      kind: args.kind,
      resolveDir: run.runtimeDir,
      pluginData: RUNTIME_DATA,
    })
    if (found.errors.length > 0 || !insideTree(found.path)) {
      return { errors: [{ text: `the preview runtime has no "${args.path}"` }] }
    }
    run.noteLibrary(found.path)
    return { path: found.path }
  }

  const fromArtifact = (build: PluginBuild, args: OnResolveArgs, importer: string) => {
    if (isRemote(args.path)) {
      if (args.kind === 'url-token' || args.kind === 'import-rule') {
        return { path: args.path, external: true }
      }
      return {
        errors: [
          { text: `cannot import ${JSON.stringify(args.path)}; an artifact has no network` },
        ],
      }
    }
    if (isRelative(args.path)) {
      const found = run.resolveLocal(args.path, importer)
      if (!found) return { errors: [{ text: `cannot find "${args.path}" (not-found)` }] }
      return { path: found, namespace: ARTIFACT }
    }
    if (allowsRuntimeImport(args.path)) return library(build, args)
    return { errors: [{ text: notAllowed(args.path) }] }
  }

  return {
    name: 'ostia-artifact',
    setup(build) {
      build.onResolve({ filter: /^ostia:entry$/ }, () =>
        entry.kind === 'component'
          ? { path: run.source.file, namespace: ARTIFACT }
          : { errors: [{ text: 'no entry' }] },
      )
      build.onResolve({ filter: /.*/, namespace: ARTIFACT }, (args) =>
        fromArtifact(build, args, args.importer),
      )
      build.onResolve({ filter: /.*/, namespace: INLINE }, (args) =>
        fromArtifact(build, args, run.source.file),
      )
      build.onResolve({ filter: /.*/, namespace: SHELL }, (args) => library(build, args))
      const resolved = new Map<string, Promise<OnResolveResult>>()
      build.onResolve({ filter: /^[^./]/, namespace: 'file' }, (args) => {
        if (args.pluginData === RUNTIME_DATA || args.kind === 'entry-point') return undefined
        const key = `${args.kind}\0${args.resolveDir}\0${args.path}`
        let found = resolved.get(key)
        if (!found) {
          found = insideRuntime(build, args)
          resolved.set(key, found)
        }
        return found
      })
      build.onLoad({ filter: /.*/, namespace: ARTIFACT }, async (args) => {
        const loader = loaderFor(args.path)
        if (!loader) {
          return {
            errors: [{ text: `${run.label(args.path)} is not a type an artifact can import` }],
          }
        }
        const body = await run.read(args.path)
        return {
          contents: loader === 'dataurl' ? body : body.toString('utf8'),
          loader,
          resolveDir: dirname(args.path),
        }
      })
      build.onLoad({ filter: /.*/, namespace: SHELL }, () => ({
        contents: shellSource,
        loader: 'js',
        resolveDir: run.runtimeDir,
      }))
      build.onLoad({ filter: /.*/, namespace: INLINE }, () => ({
        contents: entry.kind === 'inline' ? entry.code : '',
        loader: 'js',
        resolveDir: dirname(run.source.file),
      }))
    },
  }
}

export type ArtifactEntry =
  | { kind: 'component' }
  | { kind: 'module'; path: string }
  | { kind: 'inline'; code: string }
  | { kind: 'stylesheet'; path: string }

export interface Bundled {
  js: string
  css: string
}

function entryPoint(entry: ArtifactEntry): string {
  if (entry.kind === 'component') return `${SHELL}:shell`
  if (entry.kind === 'inline') return `${INLINE}:script`
  return `${ARTIFACT}:${entry.path}`
}

function entryPlugin(): Plugin {
  return {
    name: 'ostia-entry',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^(${SHELL}|${INLINE}|${ARTIFACT}):`) }, (args) => {
        if (args.kind !== 'entry-point') return undefined
        const at = args.path.indexOf(':')
        return { path: args.path.slice(at + 1), namespace: args.path.slice(0, at) }
      })
    },
  }
}

export function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1')
}

export async function bundle(
  bundler: Bundler,
  run: BuildRun,
  entry: ArtifactEntry,
  mode: PortableMode,
  target: string[],
): Promise<Bundled> {
  let result: BuildResult
  let context: BundleContext | null = null
  let release = (): void => {}
  try {
    context = await bundler.context({
      entryPoints: [entryPoint(entry)],
      bundle: true,
      write: false,
      outdir: '/ostia-out',
      entryNames: 'entry',
      format: 'esm',
      platform: 'browser',
      target,
      jsx: 'automatic',
      minify: mode === 'production',
      define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
      absWorkingDir: run.runtimeDir,
      charset: 'utf8',
      logLevel: 'silent',
      plugins: [entryPlugin(), artifactPlugin(run, entry)],
    })
    release = run.hold(context)
    result = await context.rebuild()
  } catch (error) {
    if (error instanceof BuildFailure) throw error
    throw new BuildFailure(problemsOf(error, run))
  } finally {
    release()
    void context?.dispose().catch(() => {})
  }
  const files = result.outputFiles ?? []
  const text = (extension: string): string =>
    files
      .filter((file) => file.path.endsWith(extension))
      .map((file) => file.text)
      .join('\n')
  return { js: escapeInlineScript(text('.js')), css: text('.css') }
}

interface EsbuildFailure {
  errors?: {
    text?: string
    location?: { file?: string; line?: number; column?: number } | null
    detail?: unknown
  }[]
}

function problemsOf(error: unknown, run: BuildRun): CompileProblem[] {
  const failures = (error as EsbuildFailure | null)?.errors
  const fallback = run.label(run.source.file)
  if (!Array.isArray(failures) || failures.length === 0) {
    const message = error instanceof Error ? error.message : String(error)
    return [{ file: fallback, line: 1, column: 1, message }]
  }
  return failures.map((failure) => {
    if (failure.detail instanceof BuildFailure) return failure.detail.problems[0]
    const where = failure.location
    const file = where?.file?.replace(/^[\w-]+:/, '') ?? ''
    return {
      file: file ? run.label(file) : fallback,
      line: where?.line ?? 1,
      column: (where?.column ?? 0) + 1,
      message: failure.text ?? 'does not build',
    }
  })
}
