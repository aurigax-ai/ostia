import { execFile } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { homedir, hostname, userInfo } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import type { PromptContext, PromptContextRequest } from '../shared/types'
import { type ShellState, pathDirs } from './shellCommands'

const NODE_VERSION = /^v\d+\.\d+\.\d+\S*$/
const VERSIONED_NODE_PATH = /\/v?(\d+\.\d+\.\d+)(?:\/installation)?\/bin\/node$/
const NODE_TIMEOUT_MS = 2000
const PACKAGE_WALK_LIMIT = 64
const KUBECONFIG_CAP_BYTES = 1024 * 1024
const MAX_CACHED = 32

export function virtualEnvName(path: string | null): string | null {
  if (!path) return null
  const name = basename(path.replace(/\/+$/, ''))
  return name || null
}

export function nodeVersionFromPath(nodePath: string): string | null {
  const match = VERSIONED_NODE_PATH.exec(nodePath)
  return match ? `v${match[1]}` : null
}

export async function findExecutable(pathEnv: string, name: string): Promise<string | null> {
  for (const dir of pathDirs(pathEnv)) {
    const candidate = join(dir, name)
    try {
      const info = await stat(candidate)
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate
    } catch {}
  }
  return null
}

export async function hasPackageJson(cwd: string): Promise<boolean> {
  let dir = cwd
  for (let i = 0; i < PACKAGE_WALK_LIMIT; i++) {
    try {
      if ((await stat(join(dir, 'package.json'))).isFile()) return true
    } catch {}
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

export type RunNodeVersion = (file: string) => Promise<string | null>

export const runNodeVersion: RunNodeVersion = (file) =>
  new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      { timeout: NODE_TIMEOUT_MS, shell: false, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const version = String(stdout ?? '').trim()
        resolve(!err && NODE_VERSION.test(version) ? version : null)
      },
    )
  })

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

export class NodeVersionResolver {
  private readonly cache = new Map<string, { mtimeMs: number; version: string | null }>()

  constructor(private readonly run: RunNodeVersion = runNodeVersion) {}

  async resolve(pathEnv: string): Promise<string | null> {
    const found = await findExecutable(pathEnv, 'node')
    if (!found) return null
    let real: string
    let mtimeMs: number
    try {
      real = await realpath(found)
      mtimeMs = (await stat(real)).mtimeMs
    } catch {
      return null
    }
    const fromPath = nodeVersionFromPath(real)
    if (fromPath) return fromPath
    const hit = this.cache.get(real)
    if (hit && hit.mtimeMs === mtimeMs) return hit.version
    const version = await this.run(real)
    remember(this.cache, real, { mtimeMs, version })
    return version
  }
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  if (quoted) return quoted[1]
  return value.replace(/\s+#.*$/, '')
}

export function parseKubeCurrentContext(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^current-context:[ \t]*(.*?)[ \t]*$/.exec(line)
    if (!match) continue
    const value = unquote(match[1]).trim()
    return value || null
  }
  return null
}

export function kubeconfigFiles(kubeconfigEnv: string | null, home: string): string[] {
  if (!kubeconfigEnv) return [join(home, '.kube', 'config')]
  return kubeconfigEnv.split(delimiter).filter(Boolean)
}

export class KubeContextReader {
  private readonly cache = new Map<string, { mtimeMs: number; context: string | null }>()

  private async readOne(file: string): Promise<string | null> {
    try {
      const info = await lstat(file)
      const target = info.isSymbolicLink() ? await stat(file) : info
      if (!target.isFile() || target.size > KUBECONFIG_CAP_BYTES) return null
      const hit = this.cache.get(file)
      if (hit && hit.mtimeMs === target.mtimeMs) return hit.context
      const context = parseKubeCurrentContext(await readFile(file, 'utf8'))
      remember(this.cache, file, { mtimeMs: target.mtimeMs, context })
      return context
    } catch {
      return null
    }
  }

  async read(files: readonly string[]): Promise<string | null> {
    for (const file of files) {
      const context = await this.readOne(file)
      if (context) return context
    }
    return null
  }
}

export interface PromptContextSources {
  node: NodeVersionResolver
  kube: KubeContextReader
  home?: string
  user?: string
  host?: string
}

export function shortHostname(name: string): string {
  return name.split('.')[0] || name
}

export async function promptContext(
  state: ShellState | null,
  spawnPath: string,
  cwd: string | undefined,
  want: PromptContextRequest,
  sources: PromptContextSources,
): Promise<PromptContext> {
  const home = sources.home ?? homedir()
  const pathEnv = state?.path ?? spawnPath
  const [nodeVersion, kubeContext] = await Promise.all([
    want.node && cwd && (await hasPackageJson(cwd)) ? sources.node.resolve(pathEnv) : null,
    want.kube ? sources.kube.read(kubeconfigFiles(state?.kubeconfig ?? null, home)) : null,
  ])
  return {
    user: sources.user ?? userInfo().username,
    host: shortHostname(sources.host ?? hostname()),
    home,
    virtualEnv: virtualEnvName(state?.virtualEnv ?? null),
    condaEnv: state?.condaEnv ?? null,
    nodeVersion,
    kubeContext,
  }
}
