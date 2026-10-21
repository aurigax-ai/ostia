import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isAppEnvName } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { substitutePlaceholders } from '@aurigax-ai/ostia-extension-sdk/contract/languageServerConfig'
import {
  isNodeRun,
  type LanguageServerSandboxProblem,
  LSP_LOG_LINE_MAX,
  type LspLogEntry,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import { type LogFields, redactSecrets } from '../diagnostics/appLog'
import { isInsidePath } from '../platform/pathGuard'
import type { LanguageServerSource, ServerBinaries, ServerRecord } from './serverBinaries'
import type { Session, SessionProtocol } from './sessionProtocol'

export interface LanguageServerSandbox {
  owner: (workspaceId: string) => string | null
  readable: (workspaceId: string, path: string) => boolean
  wrap: (workspaceId: string, command: string, extraReads: string[]) => Promise<string>
  env: (workspaceId: string, env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

export type SpawnServer = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false },
) => ChildProcessWithoutNullStreams

interface ServerStart {
  slotKey: string
  key: string
  pane: { windowId: string; workspaceId: string }
  root: string
  sandboxed: boolean
  deps: {
    env: () => NodeJS.ProcessEnv
    nodePath: string
    sandbox: LanguageServerSandbox
    realPath?: (path: string) => string
    log?: (event: string, fields: LogFields) => void
    spawn?: SpawnServer
  }
  binaries: ServerBinaries
  protocol: SessionProtocol
  refusals: Map<string, string>
  stopped: () => boolean
  slot: (slotKey: string) => { crashed: boolean; restartAt: number }
  enabledSource: (key: string) => LanguageServerSource | undefined
  record: (key: string) => ServerRecord
  note: (key: string, entry: LspLogEntry) => void
  now: () => number
  changed: () => void
}

export function sourceSignature(source: LanguageServerSource): string {
  return JSON.stringify([
    source.dir,
    source.server.run,
    source.server.initializationOptions ?? {},
    source.override ?? null,
  ])
}

export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (isAppEnvName(name) || name === 'ELECTRON_RUN_AS_NODE') continue
    out[name] = value
  }
  return out
}

export function findServerRoot(
  file: string,
  markers: readonly string[],
  workDir: string | undefined,
  roots: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string {
  const start = dirname(file)
  const inWorkspace = workDir !== undefined && isInsidePath(workDir, start)
  const fallback = inWorkspace ? workDir : start
  if (markers.length === 0) return fallback
  const boundary = inWorkspace
    ? workDir
    : (roots.filter((root) => isInsidePath(root, start)).sort((a, b) => b.length - a.length)[0] ??
      start)
  let dir = start
  for (;;) {
    if (markers.some((marker) => exists(join(dir, marker)))) return dir
    const parent = dirname(dir)
    if (dir === boundary || parent === dir || !isInsidePath(boundary, parent)) return fallback
    dir = parent
  }
}

export function confinedScript(extensionDir: string, script: string): string | null {
  try {
    const dir = realpathSync(extensionDir)
    const file = realpathSync(join(extensionDir, script))
    if (file === dir || !isInsidePath(dir, file)) return null
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export async function startServer(request: ServerStart): Promise<Session | null> {
  const { slotKey, key, pane, root, sandboxed, deps, binaries, protocol, refusals } = request
  const { stopped, enabledSource, note, now, changed } = request
  const slot = request.slot(slotKey)
  if (slot.crashed) return null
  const wait = slot.restartAt - now()
  if (wait > 0) await sleep(wait)
  if (stopped() || request.slot(slotKey).crashed) return null
  const source = enabledSource(key)
  if (!source) return null
  const { run } = source.server
  const env = scrubbedEnv(deps.env())
  let command: string
  let managedFolder: string | null = null
  const args: string[] = []
  const { override } = source
  if (override || !isNodeRun(run)) {
    const binary = await binaries.binaryFor(key, source)
    if (binary === null || stopped() || !enabledSource(key)) return null
    command = binary.path
    managedFolder = binary.managedFolder
  } else {
    const script = confinedScript(source.dir, run.node)
    if (script === null) {
      note(key, { at: now(), kind: 'spawn-failed', text: 'script-outside-extension' })
      return null
    }
    command = deps.nodePath
    args.push(script)
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  args.push(...run.args.map((arg) => substitutePlaceholders(arg, source.dir, root)))
  if (override) args.push(...override.args)
  const record = request.record(key)
  let spawnCommand = command
  let spawnArgs = args
  let spawnEnv = env
  if (sandboxed) {
    const { sandbox } = deps
    const refuse = (problem: LanguageServerSandboxProblem, detail: string): null => {
      record.sandboxProblem = { problem, detail }
      const refusal = `${problem}\n${detail}`
      if (refusals.get(slotKey) === refusal) return null
      refusals.set(slotKey, refusal)
      deps.log?.('lsp-sandbox-refused', { server: key, problem })
      changed()
      return null
    }
    if ((override || !isNodeRun(run)) && managedFolder === null) {
      const real = override ? (deps.realPath ?? realPathOf)(command) : command
      const hidden = [command, real].find((path) => !sandbox.readable(pane.workspaceId, path))
      if (hidden !== undefined) return refuse('program-unreadable', dirname(hidden))
    }
    if (!sandbox.readable(pane.workspaceId, root)) return refuse('folder-unreadable', root)
    try {
      const wrapped = await sandbox.wrap(
        pane.workspaceId,
        quoteArgv([command, ...args]),
        managedFolder !== null
          ? [managedFolder]
          : !override && isNodeRun(run) && !source.builtin
            ? [source.dir]
            : [],
      )
      spawnCommand = '/bin/sh'
      spawnArgs = ['-c', wrapped]
      spawnEnv = sandbox.env(pane.workspaceId, env)
    } catch (err) {
      return refuse('wrap-failed', err instanceof Error ? err.message : String(err))
    }
    if (stopped()) return null
  }
  record.sandboxProblem = null
  refusals.delete(slotKey)
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = (deps.spawn ?? spawnProcess)(spawnCommand, spawnArgs, {
      cwd: root,
      env: spawnEnv,
      shell: false,
    })
  } catch (err) {
    note(key, {
      at: now(),
      kind: 'spawn-failed',
      text: redactSecrets(err instanceof Error ? err.message : String(err)).slice(
        0,
        LSP_LOG_LINE_MAX,
      ),
    })
    return null
  }
  const session = protocol.attach({
    slotKey,
    key,
    signature: sourceSignature(source),
    source,
    pane,
    root,
    proc,
    sandboxed,
  })
  changed()
  return session
}
