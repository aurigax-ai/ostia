import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserWindow, dialog, systemPreferences } from 'electron'
import { fmt, withProductName } from '../../shared/app/dict'
import {
  POLKIT_ACTION,
  POLKIT_ACTIONS_DIR,
  POLKIT_POLICY_FILE,
} from '../../shared/permissions/scriptTokens'

const PRESENCE_TIMEOUT_MS = 120_000

export type PresenceFailure = 'cancelled' | 'failed' | 'timeout' | 'unavailable'

export type PresenceResult =
  | { ok: true; via: 'touch-id' | 'polkit' | 'confirm' }
  | { ok: false; code: PresenceFailure; detail: string }

export interface PkcheckRun {
  code: number | null
  stderr: string
  missing?: boolean
  timedOut?: boolean
}

export interface FallbackPrompt {
  reason: string
  polkitHint: boolean
}

export interface UserPresenceDeps {
  platform: NodeJS.Platform
  touchId: { canPrompt: () => boolean; prompt: (reason: string) => Promise<void> }
  policyInstalled: () => boolean
  pkcheck: (args: string[], timeoutMs: number) => Promise<PkcheckRun>
  confirm: (prompt: FallbackPrompt) => Promise<boolean | undefined>
  pid: number
  timeoutMs?: number
}

function refused(code: PresenceFailure, detail: string): PresenceResult {
  return { ok: false, code, detail }
}

function timeoutAfter(ms: number): { promise: Promise<'timeout'>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  return { promise, clear: () => clearTimeout(timer) }
}

async function viaTouchId(
  reason: string,
  deps: UserPresenceDeps,
  timeoutMs: number,
): Promise<PresenceResult> {
  let can = false
  try {
    can = deps.touchId.canPrompt()
  } catch {
    can = false
  }
  if (!can) return refused('unavailable', 'Touch ID is not available on this Mac')
  const timer = timeoutAfter(timeoutMs)
  try {
    const outcome = await Promise.race([
      deps.touchId.prompt(reason).then(() => 'ok'),
      timer.promise,
    ])
    if (outcome === 'timeout') return refused('timeout', 'Touch ID got no answer in time')
    return { ok: true, via: 'touch-id' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return /cancel/i.test(message)
      ? refused('cancelled', 'Touch ID was cancelled')
      : refused('failed', `Touch ID failed: ${message}`)
  } finally {
    timer.clear()
  }
}

async function viaPolkit(deps: UserPresenceDeps, timeoutMs: number): Promise<PresenceResult> {
  if (!deps.policyInstalled()) {
    return refused('unavailable', `the polkit action ${POLKIT_ACTION} is not installed`)
  }
  const run = await deps.pkcheck(
    ['--action-id', POLKIT_ACTION, '--process', String(deps.pid), '--allow-user-interaction'],
    timeoutMs,
  )
  if (run.missing) return refused('unavailable', 'pkcheck is not installed')
  if (run.timedOut) return refused('timeout', 'polkit got no answer in time')
  const said = run.stderr.trim()
  if (run.code === 0) return { ok: true, via: 'polkit' }
  if (run.code === 1) return refused('failed', `polkit refused${said ? `: ${said}` : ''}`)
  if (run.code === 2) return refused('unavailable', 'no polkit authentication agent is running')
  if (run.code === 3) return refused('cancelled', 'the polkit prompt was dismissed')
  if (/not registered/i.test(said)) {
    return refused('unavailable', `the polkit action ${POLKIT_ACTION} is not registered`)
  }
  return refused(
    'failed',
    `pkcheck exited with ${run.code ?? 'a signal'}${said ? `: ${said}` : ''}`,
  )
}

function viaSystem(reason: string, deps: UserPresenceDeps, timeoutMs: number) {
  if (deps.platform === 'darwin') return viaTouchId(reason, deps, timeoutMs)
  if (deps.platform === 'linux') return viaPolkit(deps, timeoutMs)
  return Promise.resolve(refused('unavailable', `no system authentication on ${deps.platform}`))
}

export async function verifyUserPresence(
  reason: string,
  deps: UserPresenceDeps,
): Promise<PresenceResult> {
  const timeoutMs = deps.timeoutMs ?? PRESENCE_TIMEOUT_MS
  let system: PresenceResult
  try {
    system = await viaSystem(reason, deps, timeoutMs)
  } catch (err) {
    return refused('failed', `system authentication failed: ${(err as Error).message}`)
  }
  if (system.ok || system.code !== 'unavailable') return system
  const timer = timeoutAfter(timeoutMs)
  try {
    const answer = await Promise.race([
      deps.confirm({ reason, polkitHint: deps.platform === 'linux' }),
      timer.promise,
    ])
    if (answer === 'timeout') return refused('timeout', 'the confirmation got no answer in time')
    if (answer === undefined) {
      return refused('unavailable', `${system.detail}, and no window can ask instead`)
    }
    return answer
      ? { ok: true, via: 'confirm' }
      : refused('cancelled', 'the confirmation was declined')
  } catch (err) {
    return refused('failed', `the confirmation failed: ${(err as Error).message}`)
  } finally {
    timer.clear()
  }
}

export function runPkcheck(args: string[], timeoutMs: number): Promise<PkcheckRun> {
  return new Promise((resolve) => {
    let stderr = ''
    let timedOut = false
    const child = spawn('pkcheck', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ code: null, stderr: err.message, missing: err.code === 'ENOENT' })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(timedOut ? { code, stderr, timedOut } : { code, stderr })
    })
  })
}

export interface FallbackText {
  title: string
  message: string
  detailMac: string
  detailLinux: string
  detailOther: string
  confirm: string
  cancel: string
}

export function installPolkitCommand(resourcesPath: string): string {
  return `sudo "${join(resourcesPath, 'bin', 'ostia')}" install-polkit`
}

export function fallbackOptions(
  prompt: FallbackPrompt,
  platform: NodeJS.Platform,
  text: FallbackText,
  command: string,
): Electron.MessageBoxOptions {
  const detail =
    platform === 'darwin' ? text.detailMac : prompt.polkitHint ? text.detailLinux : text.detailOther
  return {
    type: 'warning',
    title: withProductName(text.title),
    message: withProductName(fmt(text.message, { reason: prompt.reason })),
    detail: withProductName(fmt(detail, { command })),
    buttons: [text.confirm, text.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

export function electronPresenceDeps(
  windows: () => Iterable<BrowserWindow>,
  text: () => FallbackText,
  resourcesPath: string,
): UserPresenceDeps {
  return {
    platform: process.platform,
    touchId: {
      canPrompt: () => systemPreferences.canPromptTouchID(),
      prompt: (reason) => systemPreferences.promptTouchID(reason),
    },
    policyInstalled: () => existsSync(join(POLKIT_ACTIONS_DIR, POLKIT_POLICY_FILE)),
    pkcheck: runPkcheck,
    confirm: async (prompt) => {
      const all = [...windows()].filter((w) => !w.isDestroyed())
      const win = all.find((w) => w.isFocused()) ?? all[0]
      if (!win) return undefined
      const { response } = await dialog.showMessageBox(
        win,
        fallbackOptions(prompt, process.platform, text(), installPolkitCommand(resourcesPath)),
      )
      return response === 0
    },
    pid: process.pid,
  }
}
