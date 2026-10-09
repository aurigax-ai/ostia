import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Electron,
  type ElectronApplication,
  test as base,
  _electron as playwrightElectron,
} from '@playwright/test'

import { isolatedLaunch } from './dataHome'
import { processRows } from './processes'

export * from '@playwright/test'

const recording = new Map<ElectronApplication, string>()
const recorded: string[] = []

function recordsTrace(): boolean {
  const option = base.info().project.use.trace
  const mode = typeof option === 'string' ? option : option?.mode
  return mode === 'on' || mode === 'retain-on-failure'
}

async function stopTrace(app: ElectronApplication): Promise<void> {
  const path = recording.get(app)
  if (!path) return
  recording.delete(app)
  try {
    await app.context().tracing.stop({ path })
    recorded.push(path)
  } catch {
    rmSync(path, { force: true })
  }
}

function processExit(app: ElectronApplication): Promise<void> {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

const CLOSE_DEADLINE_MS = 20_000
const USER_DATA_FLAG = '--user-data-dir='

const CRASH_DUMPS_ENV = 'OSTIA_E2E_CRASH_DUMPS'

interface Launched {
  child: ChildProcess
  log: string | null
  reported: boolean
  output: string[]
  crashDumps: string
}

export function exitLine(child: ChildProcess): string {
  if (child.signalCode !== null)
    return `the app (pid ${child.pid}) was ended by ${child.signalCode}`
  if (child.exitCode !== null)
    return `the app (pid ${child.pid}) exited with code ${child.exitCode}`
  return `the app (pid ${child.pid}) is still running`
}

export function crashDumpsIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.dmp'))
    .map((name) => join(dir, name))
    .sort()
}

const PTRACE_SCOPE_FILE = '/proc/sys/kernel/yama/ptrace_scope'
const PTRACE_FORBIDDEN = '3'

export function crashDumpsPossible(): boolean {
  try {
    return readFileSync(PTRACE_SCOPE_FILE, 'utf8').trim() !== PTRACE_FORBIDDEN
  } catch {
    return true
  }
}

export function exitReport(child: ChildProcess, dumps: readonly string[]): string {
  if (dumps.length > 0 || child.signalCode === null || crashDumpsPossible()) return exitLine(child)
  return `${exitLine(child)}\nno crash dump: this machine forbids ptrace (kernel.yama.ptrace_scope=${PTRACE_FORBIDDEN}), which the crash handler needs`
}

function keepOutput(child: ChildProcess): string[] {
  const output: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')))
  return output
}

const launched = new Map<ElectronApplication, Launched>()

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

const EXIT_SETTLE_MS = 2000

async function exitedSoon(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), EXIT_SETTLE_MS)
    }),
  ])
  clearTimeout(timer)
  return exited
}

function processTree(root: number): string {
  try {
    return processRows(root, 'stat=,etime=,comm=')
      .map((row) => row.line)
      .join('\n')
  } catch {
    return 'ps failed'
  }
}

function quitLines(log: string): string {
  if (!existsSync(log)) return 'no main.log'
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => /\b(quit-[a-z]+|app-quit)\b/.test(line))
    .join('\n')
}

async function reportStuck(entry: Launched, when: string): Promise<string> {
  const { child, log } = entry
  entry.reported = true
  const tree = child.pid ? processTree(child.pid) : 'no pid'
  const stages = log ? quitLines(log) : 'no user data folder'
  const report = `the app (pid ${child.pid}) was still running ${when}\nprocesses:\n${tree}\nquit log:\n${stages}`
  console.error(report)
  await base.info().attach('app-still-running', { body: report, contentType: 'text/plain' })
  child.kill('SIGKILL')
  return report
}

async function closeWithin(
  app: Launched,
  close: () => Promise<void>,
  exited: Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), CLOSE_DEADLINE_MS)
  })
  const closed = close()
    .then(() => exited)
    .then(() => 'closed' as const)
  const outcome = await Promise.race([closed, late])
  clearTimeout(timer)
  if (outcome === 'closed') return
  closed.catch(() => {})
  throw new Error(await reportStuck(app, `${CLOSE_DEADLINE_MS / 1000} s after close`))
}

export const _electron: Electron = {
  async launch(options) {
    const crashDumps = base.info().outputPath(`crash-dumps-${launched.size + 1}`)
    const env = { ...(options?.env ?? (process.env as Record<string, string>)) }
    const app = await playwrightElectron.launch({
      ...options,
      env: { ...env, [CRASH_DUMPS_ENV]: env[CRASH_DUMPS_ENV] ?? crashDumps },
    })
    const userData = options?.args?.find((arg) => arg.startsWith(USER_DATA_FLAG))
    const entry: Launched = {
      child: app.process(),
      reported: false,
      output: keepOutput(app.process()),
      crashDumps: env[CRASH_DUMPS_ENV] ?? crashDumps,
      log: userData ? join(userData.slice(USER_DATA_FLAG.length), 'logs', 'main.log') : null,
    }
    launched.set(app, entry)
    if (recordsTrace()) {
      const path = base.info().outputPath(`app-trace-${recording.size + recorded.length + 1}.zip`)
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      recording.set(app, path)
    }
    const close = app.close.bind(app)
    app.close = async () => {
      const exited = processExit(app)
      await stopTrace(app)
      await closeWithin(entry, close, exited)
    }
    return app
  },
}

const WARM_UP_WAIT_MS = 60_000

async function warmUp(): Promise<void> {
  const started = Date.now()
  const app = await playwrightElectron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow({ timeout: WARM_UP_WAIT_MS })
    await win
      .locator('.workzone-empty')
      .getByRole('button', { name: /New workspace/ })
      .click({ timeout: WARM_UP_WAIT_MS })
    await win
      .locator('.workspace-empty:visible')
      .getByRole('button', { name: 'New terminal' })
      .click({ timeout: WARM_UP_WAIT_MS })
    await win.locator('.xterm, .ghostty-host').first().waitFor({ timeout: WARM_UP_WAIT_MS })
    console.log(`e2e warm-up: the app opened a terminal in ${Date.now() - started} ms`)
  } catch (error) {
    console.log(`e2e warm-up: gave up after ${Date.now() - started} ms: ${error}`)
  } finally {
    const exited = processExit(app)
    await Promise.race([
      app.close().then(() => exited),
      new Promise((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
    ]).catch(() => {})
    if (!hasExited(app.process())) app.process().kill('SIGKILL')
  }
}

export const test = base.extend<{ appTraces: undefined }, { warmApp: undefined }>({
  warmApp: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern
    async ({}, use) => {
      if (process.platform === 'darwin' && process.env.CI) await warmUp()
      await use(undefined)
    },
    { scope: 'worker', auto: true, timeout: 3 * WARM_UP_WAIT_MS },
  ],
  appTraces: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern
    async ({}, use, testInfo) => {
      await use(undefined)
      await Promise.all([...recording.keys()].map(stopTrace))
      const failed = testInfo.status !== testInfo.expectedStatus
      for (const entry of launched.values()) {
        if (!entry.reported && !(await exitedSoon(entry.child)))
          await reportStuck(entry, 'when the test ended')
        if (!failed) continue
        const dumps = crashDumpsIn(entry.crashDumps)
        const report = exitReport(entry.child, dumps)
        console.error(report)
        await testInfo.attach('app-exit', { body: report, contentType: 'text/plain' })
        await testInfo.attach('app-stderr', {
          body: entry.output.join(''),
          contentType: 'text/plain',
        })
        for (const path of dumps) {
          console.error(`crash dump of pid ${entry.child.pid}: ${path}`)
          await testInfo.attach('crash-dump', { path, contentType: 'application/octet-stream' })
        }
        if (entry.log && existsSync(entry.log)) {
          console.error(`quit log of pid ${entry.child.pid}:\n${quitLines(entry.log)}`)
          await testInfo.attach('main-log', { path: entry.log, contentType: 'text/plain' })
        }
      }
      launched.clear()
      for (const path of recorded.splice(0)) {
        if (failed) await testInfo.attach('trace', { path, contentType: 'application/zip' })
        rmSync(path, { force: true })
      }
    },
    { auto: true },
  ],
})
