import { type SpawnOptions, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isAppEnvName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { type ExtensionMethodContext, registerControlMethod } from '../control/controlServer'
import { withoutGpuLaunchEnv } from '../platform/discreteGpu'
import { inheritableFds, withoutInheritedFiles } from '../platform/inheritableFiles'
import type { ExtensionHost } from './extensionHost'
import { fail } from './extensionRuntime'

type Wire = typeof import('@aurigax-ai/wire')
type PathEnv = NonNullable<Parameters<Wire['runtimePaths']>[0]>

export const WIRE_CLIENT = 'ostia'
const WIRE_RIGHTS = ['observe', 'start', 'control', 'ingest', 'worker', 'enable'] as const
const WIRE_START_WAIT_MS = 5_000

export type WireRuntimeAnswer =
  | { ok: true; socket: string; token: string; started: boolean; mode: string; version: string }
  | { ok: false; error: 'other-contract'; contract?: number; version?: string }
  | { ok: false; error: 'not-started'; message: string }

export interface WireRuntimeDeps {
  nodePath: string
  baseEnv: () => NodeJS.ProcessEnv
  pathEnv?: () => PathEnv
  binPath?: () => string
  spawn?: (file: string, args: string[], options: SpawnOptions) => { unref: () => void }
  inheritableFds?: () => number[]
}

type Probe =
  | { kind: 'ok'; mode: string; version: string }
  | { kind: 'other'; contract?: number; version?: string }
  | { kind: 'refused' }
  | { kind: 'absent' }
  | { kind: 'unknown'; code: string }

const NO_RUNTIME = new Set(['ENOENT', 'ECONNREFUSED'])

function wireBin(): string {
  const manifest = createRequire(__filename).resolve('@aurigax-ai/wire/package.json')
  return join(dirname(manifest), 'dist', 'cli', 'bin.js')
}

function runtimeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(withoutGpuLaunchEnv(base)))
    if (value !== undefined && !isAppEnvName(name)) out[name] = value
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

export class WireRuntime {
  private wire: Promise<Wire> | null = null
  private starting: Promise<WireRuntimeAnswer> | null = null

  constructor(private readonly deps: WireRuntimeDeps) {}

  private load(): Promise<Wire> {
    this.wire ??= import('@aurigax-ai/wire')
    return this.wire
  }

  connect(): Promise<WireRuntimeAnswer> {
    this.starting ??= this.connectOnce().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async connectOnce(): Promise<WireRuntimeAnswer> {
    const wire = await this.load()
    const paths = wire.runtimePaths(this.deps.pathEnv?.())
    let token =
      wire.readProvisionedToken(paths.data, WIRE_CLIENT) ??
      wire.provisionToken(paths.data, WIRE_CLIENT, WIRE_RIGHTS)
    let probe = await this.probe(wire, paths.socket, token)
    let started = false
    if (probe.kind === 'refused') {
      token = wire.provisionToken(paths.data, WIRE_CLIENT, WIRE_RIGHTS)
      await this.reload(wire, paths)
      probe = await this.until(wire, paths.socket, token)
    } else if (probe.kind === 'absent') {
      this.start()
      started = true
      probe = await this.until(wire, paths.socket, token)
    }
    if (probe.kind === 'other')
      return {
        ok: false,
        error: 'other-contract',
        ...(probe.contract !== undefined ? { contract: probe.contract } : {}),
        ...(probe.version !== undefined ? { version: probe.version } : {}),
      }
    if (probe.kind === 'unknown')
      return {
        ok: false,
        error: 'not-started',
        message: `the runtime socket gave ${probe.code}; nothing was started or replaced`,
      }
    if (probe.kind !== 'ok')
      return {
        ok: false,
        error: 'not-started',
        message: `the runtime did not answer (${probe.kind})`,
      }
    return {
      ok: true,
      socket: paths.socket,
      token,
      started,
      mode: probe.mode,
      version: probe.version,
    }
  }

  private async probe(wire: Wire, socket: string, token: string): Promise<Probe> {
    try {
      const client = await wire.RuntimeClient.connect({ socket, token })
      client.close()
      return { kind: 'ok', mode: client.hello.mode, version: client.hello.version }
    } catch (err) {
      if (err instanceof wire.RuntimeCallError) {
        if (err.message === 'unsupported-contract') {
          const data = (err.data ?? {}) as { contract?: unknown; version?: unknown }
          return {
            kind: 'other',
            ...(typeof data.contract === 'number' ? { contract: data.contract } : {}),
            ...(typeof data.version === 'string' ? { version: data.version } : {}),
          }
        }
        return { kind: 'refused' }
      }
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error'
      return NO_RUNTIME.has(code) ? { kind: 'absent' } : { kind: 'unknown', code }
    }
  }

  private async until(wire: Wire, socket: string, token: string): Promise<Probe> {
    const deadline = Date.now() + WIRE_START_WAIT_MS
    for (;;) {
      const probe = await this.probe(wire, socket, token)
      if (probe.kind === 'ok' || probe.kind === 'other' || Date.now() > deadline) return probe
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  private async reload(wire: Wire, paths: { socket: string; data: string }): Promise<void> {
    try {
      const client = await wire.RuntimeClient.connect({
        socket: paths.socket,
        token: wire.readCliToken(paths.data) ?? '',
      })
      try {
        const { pid } = await client.call<{ pid: number }>('runtime.status')
        process.kill(pid, 'SIGHUP')
      } finally {
        client.close()
      }
    } catch {}
  }

  private start(): void {
    const { stdio, release } = withoutInheritedFiles(
      ['ignore', 'ignore', 'ignore'],
      (this.deps.inheritableFds ?? inheritableFds)(),
    )
    try {
      const child = (this.deps.spawn ?? spawn)(
        this.deps.nodePath,
        [(this.deps.binPath ?? wireBin)(), 'runtime', 'start'],
        { detached: true, shell: false, stdio, env: runtimeEnv(this.deps.baseEnv()) },
      )
      child.unref()
    } finally {
      release()
    }
  }
}

export const WIRE_EXTENSION = 'graphs'

type HostCheck = Pick<ExtensionHost, 'builtinId'>

export function answerWireRuntime(
  host: HostCheck | null,
  runtime: Pick<WireRuntime, 'connect'>,
  ctx: {
    identity: Parameters<HostCheck['builtinId']>[0]
    conn: Parameters<HostCheck['builtinId']>[1]
  },
) {
  if (!host) return fail('no-extension-host')
  if (host.builtinId(ctx.identity, ctx.conn) !== WIRE_EXTENSION) return fail('graphs-only')
  return runtime.connect()
}

export function registerWireRuntime(deps: {
  host: () => ExtensionHost | null
  runtime: WireRuntime
}): void {
  registerControlMethod('ext.wireRuntime', {
    callers: 'extensions',
    handler: (_params, ctx: ExtensionMethodContext) =>
      answerWireRuntime(deps.host(), deps.runtime, ctx),
  })
}
