import { type ChildProcess, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { envName, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  AGENT_ARGS_ENV,
  AGENT_ARGS_SEPARATOR,
  CODEX_HOOK_ARGS_JSON,
} from '../../shared/agents/agentLaunch'

const SERVER_WAIT_MS = 10_000
const POLL_MS = 100

type Env = Record<string, string | undefined>

export interface CodexServerIo {
  env: Env
  cwd: string
  findCodex: (path: string | undefined) => string | undefined
  spawnServer: (bin: string, args: string[], env: Env, cwd: string) => number | undefined
  alive: (pid: number) => boolean
  kill: (pid: number) => void
  sleep: (ms: number) => Promise<void>
  attach: () => Promise<unknown>
  detach: () => Promise<unknown>
}

export function userRemote(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--remote' || arg.startsWith('--remote='))
}

function hookArgs(agentDir: string | undefined): string[] | undefined {
  if (!agentDir) return undefined
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(agentDir, 'codex', CODEX_HOOK_ARGS_JSON), 'utf8'),
    )
    return Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')
      ? (parsed as string[])
      : undefined
  } catch {
    return undefined
  }
}

export async function startCodexServer(
  args: readonly string[],
  io: CodexServerIo,
): Promise<string | undefined> {
  const socket = readEnv('CODEX_SOCK', io.env)
  const flags = hookArgs(readEnv('AGENT_DIR', io.env))
  const bin = io.findCodex(io.env.PATH)
  if (!socket || !flags || !bin || userRemote(args)) return undefined
  rmSync(socket, { force: true })
  const env = { ...io.env, [envName(AGENT_ARGS_ENV.codex)]: args.join(AGENT_ARGS_SEPARATOR) }
  const pid = io.spawnServer(
    bin,
    [...flags, 'app-server', '--listen', `unix://${socket}`],
    env,
    io.cwd,
  )
  if (pid === undefined) return undefined
  for (let waited = 0; waited < SERVER_WAIT_MS; waited += POLL_MS) {
    if (existsSync(socket)) break
    if (!io.alive(pid)) return undefined
    await io.sleep(POLL_MS)
  }
  if (!existsSync(socket)) {
    io.kill(pid)
    return undefined
  }
  writeFileSync(`${socket}.pid`, String(pid), { mode: 0o600 })
  await io.attach()
  return socket
}

export async function stopCodexServer(io: CodexServerIo): Promise<void> {
  const socket = readEnv('CODEX_SOCK', io.env)
  if (!socket) return
  await io.detach()
  try {
    const pid = Number(readFileSync(`${socket}.pid`, 'utf8'))
    if (Number.isInteger(pid) && pid > 0) io.kill(pid)
  } catch {}
  rmSync(`${socket}.pid`, { force: true })
  rmSync(socket, { force: true })
}

function findOnPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

function realIo(conn: MessageConnection): CodexServerIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    findCodex: (path) => findOnPath('codex', path),
    spawnServer: (bin, args, env, cwd) => {
      const child: ChildProcess = spawn(bin, args, { cwd, env, detached: true, stdio: 'ignore' })
      child.unref()
      return child.pid
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    kill: (pid) => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attach: () => conn.sendRequest('codex.attach'),
    detach: () => conn.sendRequest('codex.detach'),
  }
}

export async function runCodexServerVerb(conn: MessageConnection): Promise<void> {
  const [sub, ...rest] = process.argv.slice(3)
  const io = realIo(conn)
  if (sub === 'start') {
    const dash = rest.indexOf('--')
    const socket = await startCodexServer(dash < 0 ? [] : rest.slice(dash + 1), io)
    if (socket) console.log(socket)
  } else if (sub === 'stop') {
    await stopCodexServer(io)
  } else {
    process.exitCode = 1
  }
}
