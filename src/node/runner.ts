import { once } from 'node:events'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { setBusPath } from '../main/agents/busStore'
import { NODE_STATUS_PREFIX } from '../shared/remote/remoteNode'
import { listenControl } from './control'
import { JobStarter } from './jobStart'
import { Jobs } from './jobs'
import { RunnerLink } from './link'
import { incompatibleLine, runLinkBridge } from './linkBridge'
import { adminMethods, reap } from './nodeAdmin'
import { nodePaths } from './nodePaths'
import { TmuxHost } from './tmuxHost'

const REAP_MS = 5000
const START_TRIES = 50
const START_POLL_MS = 100
const RUNNER_SESSION = 'runner'
const VERSION_DIR = /^[0-9a-f]{12}$/

const versionDir = __dirname
const version = basename(versionDir)
const paths = nodePaths(homedir())

async function call<T>(method: string, params?: unknown): Promise<T> {
  const socket = createConnection(paths.socket)
  await once(socket, 'connect')
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  try {
    return await conn.sendRequest<T>(method, params)
  } finally {
    conn.dispose()
    socket.destroy()
  }
}

async function runningVersion(): Promise<string | null> {
  try {
    return (await call<{ version: string }>('node.ping')).version
  } catch {
    return null
  }
}

function sweepOldVersions(jobs: Jobs): void {
  if (jobs.list().length > 0) return
  for (const entry of readdirSync(dirname(versionDir))) {
    if (VERSION_DIR.test(entry) && entry !== version) {
      rmSync(join(dirname(versionDir), entry), { recursive: true, force: true })
    }
  }
}

async function serve(): Promise<void> {
  setBusPath(paths.bus)
  const jobs = new Jobs(paths.jobs)
  const tmux = new TmuxHost(paths.tmuxSocket, paths.tmuxConf)
  sweepOldVersions(jobs)
  const link = new RunnerLink(jobs, version)
  const starter = new JobStarter({ paths, versionDir, jobs, tmux })
  const deps = {
    paths,
    versionDir,
    version,
    jobs,
    tmux,
    link,
    starter,
    shutdown: () => process.exit(0),
  }
  await listenControl({ socket: paths.socket, version, jobs, link, admin: adminMethods(deps) })
  setInterval(() => void reap(deps), REAP_MS).unref()
}

async function start(dir: string = versionDir): Promise<void> {
  const tmux = new TmuxHost(paths.tmuxSocket, paths.tmuxConf)
  await tmux.create({
    name: RUNNER_SESSION,
    cwd: homedir(),
    env: {},
    argv: [process.execPath, join(dir, 'ostia-node.js'), 'serve'],
  })
  for (let i = 0; i < START_TRIES; i++) {
    if ((await runningVersion()) !== null) return
    await sleep(START_POLL_MS)
  }
  throw new Error('runner-stopped')
}

async function replaceRunner(running: string): Promise<unknown> {
  const tmux = new TmuxHost(paths.tmuxSocket, paths.tmuxConf)
  await tmux.kill(RUNNER_SESSION).catch(() => {})
  await sleep(START_POLL_MS * 2)
  try {
    await start()
  } catch (err) {
    await tmux.kill(RUNNER_SESSION).catch(() => {})
    await start(join(dirname(versionDir), running)).catch(() => {})
    throw err
  }
  return { version }
}

async function ensure(replace: boolean): Promise<unknown> {
  const running = await runningVersion()
  if (running === version) return { version }
  if (running !== null) {
    if (!replace) return { ok: false, error: 'incompatible', running, version }
    return replaceRunner(running)
  }
  await start()
  return { version }
}

function stdinParams(): { replace?: boolean } | undefined {
  if (process.stdin.isTTY) return undefined
  try {
    const raw = readFileSync(0, 'utf8').trim()
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'serve') return serve()
  if (command === 'link') {
    const running = await ensure(false).catch(() => null)
    if (!running || (running as { ok?: boolean }).ok === false) {
      process.stdout.write(incompatibleLine(version))
      process.exit(0)
    }
    return runLinkBridge(paths.socket)
  }
  const params = stdinParams()
  let result: unknown
  try {
    if (command === 'ensure') result = await ensure(params?.replace === true)
    else if (
      command === 'ping' ||
      command === 'jobs' ||
      command === 'stop' ||
      command === 'start' ||
      command === 'result' ||
      command === 'selftest'
    ) {
      result = await call(`node.${command}`, params)
    } else if (command === 'pane-new') result = await call('node.paneNew', params)
    else if (command === 'repo-init') result = await call('node.repoInit', params)
    else result = { ok: false, error: 'unknown-command' }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  process.stdout.write(`${NODE_STATUS_PREFIX}${JSON.stringify(result)}\n`)
  process.exit(0)
}

void main()
