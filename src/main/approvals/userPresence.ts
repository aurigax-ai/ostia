import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, systemPreferences } from 'electron'
import { fmt, withProductName } from '../../shared/app/dict'
import {
  POLKIT_ACTION,
  POLKIT_ACTIONS_DIR,
  POLKIT_POLICY_FILE,
} from '../../shared/permissions/scriptTokens'

const PRESENCE_TIMEOUT_MS = 120_000
const ALLOW_TITLE = 'ostia-presence:allow:'
const CANCEL_TITLE = 'ostia-presence:cancel'

export const PKCHECK_PATHS = ['/usr/bin/pkcheck', '/bin/pkcheck']

export type PresenceFailure = 'cancelled' | 'failed' | 'timeout' | 'unavailable'

export type PresenceResult =
  | { ok: true; via: 'touch-id' | 'polkit' | 'confirm' }
  | { ok: false; code: PresenceFailure; detail: string; hint?: 'polkit-agent' }

export interface PresenceAsk {
  reason: string
  name: string
}

export interface PkcheckRun {
  code: number | null
  stderr: string
  missing?: boolean
  timedOut?: boolean
}

export interface FallbackPrompt extends PresenceAsk {
  polkitHint: boolean
}

export interface UserPresenceDeps {
  platform: NodeJS.Platform
  touchId: { canPrompt: () => boolean; prompt: (reason: string) => Promise<void> }
  policyInstalled: () => boolean
  pkcheck: (args: string[], timeoutMs: number) => Promise<PkcheckRun>
  confirm: (prompt: FallbackPrompt, signal: AbortSignal) => Promise<boolean | undefined>
  pid: number
  timeoutMs?: number
}

type SystemAnswer = PresenceResult | { ask: string }

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
): Promise<SystemAnswer> {
  let can = false
  try {
    can = deps.touchId.canPrompt()
  } catch {
    can = false
  }
  if (!can) return { ask: 'Touch ID is not available on this Mac' }
  const timer = timeoutAfter(timeoutMs)
  try {
    const outcome = await Promise.race([
      deps.touchId.prompt(reason).then(() => 'ok'),
      timer.promise,
    ])
    if (outcome === 'timeout') return refused('timeout', 'Touch ID got no answer in time')
    return { ok: true, via: 'touch-id' }
  } catch (err) {
    return refused('failed', `Touch ID did not confirm: ${(err as Error).message}`)
  } finally {
    timer.clear()
  }
}

async function viaPolkit(deps: UserPresenceDeps, timeoutMs: number): Promise<SystemAnswer> {
  if (!deps.policyInstalled()) return { ask: `the polkit action ${POLKIT_ACTION} is not installed` }
  const run = await deps.pkcheck(
    ['--action-id', POLKIT_ACTION, '--process', String(deps.pid), '--allow-user-interaction'],
    timeoutMs,
  )
  const said = run.stderr.trim()
  const why = said ? `: ${said}` : ''
  if (run.missing) return refused('unavailable', `pkcheck is not installed${why}`)
  if (run.timedOut) return refused('timeout', 'polkit got no answer in time')
  if (run.code === 0) return { ok: true, via: 'polkit' }
  if (run.code === 1) return refused('failed', `polkit refused${why}`)
  if (run.code === 2) {
    return {
      ok: false,
      code: 'unavailable',
      detail: `no polkit authentication agent is running; install and start the one for your desktop (polkit-gnome, polkit-kde-agent-1, lxqt-policykit or mate-polkit) and try again${why}`,
      hint: 'polkit-agent',
    }
  }
  if (run.code === 3) return refused('cancelled', 'the polkit prompt was dismissed')
  return refused('failed', `pkcheck exited with ${run.code ?? 'a signal'}${why}`)
}

function viaSystem(
  reason: string,
  deps: UserPresenceDeps,
  timeoutMs: number,
): Promise<SystemAnswer> {
  if (deps.platform === 'darwin') return viaTouchId(reason, deps, timeoutMs)
  if (deps.platform === 'linux') return viaPolkit(deps, timeoutMs)
  return Promise.resolve({ ask: `no system authentication on ${deps.platform}` })
}

export async function verifyUserPresence(
  request: PresenceAsk,
  deps: UserPresenceDeps,
): Promise<PresenceResult> {
  const timeoutMs = deps.timeoutMs ?? PRESENCE_TIMEOUT_MS
  let system: SystemAnswer
  try {
    system = await viaSystem(request.reason, deps, timeoutMs)
  } catch (err) {
    return refused('failed', `system authentication failed: ${(err as Error).message}`)
  }
  if (!('ask' in system)) return system
  const timer = timeoutAfter(timeoutMs)
  const stop = new AbortController()
  try {
    const answer = await Promise.race([
      deps.confirm({ ...request, polkitHint: deps.platform === 'linux' }, stop.signal),
      timer.promise,
    ])
    if (answer === 'timeout') return refused('timeout', 'the confirmation got no answer in time')
    if (answer === undefined) {
      return refused('unavailable', `${system.ask}, and no window can ask instead`)
    }
    return answer
      ? { ok: true, via: 'confirm' }
      : refused('cancelled', 'the confirmation was declined')
  } catch (err) {
    return refused('failed', `the confirmation failed: ${(err as Error).message}`)
  } finally {
    timer.clear()
    stop.abort()
  }
}

export function runPkcheck(
  args: string[],
  timeoutMs: number,
  candidates: readonly string[] = PKCHECK_PATHS,
): Promise<PkcheckRun> {
  const bin = candidates.find((p) => existsSync(p))
  if (!bin) {
    return Promise.resolve({ code: null, stderr: `not in ${candidates.join(', ')}`, missing: true })
  }
  return new Promise((resolve) => {
    let stderr = ''
    let timedOut = false
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stderr: err.message })
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
  typeName: string
  detailMac: string
  detailLinux: string
  detailOther: string
  confirm: string
  cancel: string
}

export function installPolkitCommand(resourcesPath: string): string {
  return `sudo "${join(resourcesPath, 'bin', 'ostia')}" install-polkit`
}

function html(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function scriptString(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c')
}

export function fallbackPage(
  prompt: FallbackPrompt,
  platform: NodeJS.Platform,
  text: FallbackText,
  command: string,
): string {
  const detail =
    platform === 'darwin' ? text.detailMac : prompt.polkitHint ? text.detailLinux : text.detailOther
  const t = (s: string, vars: Record<string, string> = {}) => html(withProductName(fmt(s, vars)))
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>${t(text.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2022;--muted:#5b6168;--line:#d5d9de;--brand:#0b62c4}
@media (prefers-color-scheme:dark){:root{--bg:#1d2022;--fg:#e8eaed;--muted:#9aa1a9;--line:#3a3f44;--brand:#00a8cc}}
body{margin:0;padding:20px;background:var(--bg);color:var(--fg);font:13px system-ui,sans-serif}
h1{font-size:14px;margin:0 0 8px}p{margin:0 0 10px;color:var(--muted);line-height:1.45}
label{display:block;margin:12px 0 6px}input{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}button{height:28px;padding:0 14px;border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
button[type=submit]{background:var(--brand);border-color:var(--brand);color:#fff}button:disabled{opacity:.45}
</style></head>
<body><form id="f">
<h1>${t(text.message, { reason: prompt.reason })}</h1>
<p>${t(detail, { command })}</p>
<label for="name">${t(text.typeName, { name: prompt.name })}</label>
<input id="name" autocomplete="off" spellcheck="false" autofocus>
<div class="row"><button type="button" id="cancel">${t(text.cancel)}</button><button type="submit" id="allow" disabled>${t(text.confirm)}</button></div>
</form>
<script>
const expected = ${scriptString(prompt.name)}
const input = document.getElementById('name')
const allow = document.getElementById('allow')
input.addEventListener('input', () => { allow.disabled = input.value !== expected })
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault()
  if (input.value !== expected) return
  document.title = ${scriptString(ALLOW_TITLE)} + input.value
})
const cancel = () => { document.title = ${scriptString(CANCEL_TITLE)} }
document.getElementById('cancel').addEventListener('click', cancel)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel() })
</script></body></html>`
}

export function fallbackAnswer(title: string, name: string): boolean | undefined {
  if (title === CANCEL_TITLE) return false
  if (!title.startsWith(ALLOW_TITLE)) return undefined
  return title.slice(ALLOW_TITLE.length) === name
}

function askInWindow(
  parent: BrowserWindow,
  page: string,
  name: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 460,
      height: 280,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    let settled = false
    const done = (answer: boolean): void => {
      if (settled) return
      settled = true
      resolve(answer)
      if (!win.isDestroyed()) win.close()
    }
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('page-title-updated', (e, title) => {
      e.preventDefault()
      const answer = fallbackAnswer(title, name)
      if (answer !== undefined) done(answer)
    })
    win.once('closed', () => done(false))
    signal.addEventListener('abort', () => done(false), { once: true })
    win.once('ready-to-show', () => win.show())
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => done(false))
  })
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
    pkcheck: (args, timeoutMs) => runPkcheck(args, timeoutMs),
    confirm: async (prompt, signal) => {
      const all = [...windows()].filter((w) => !w.isDestroyed())
      const parent = all.find((w) => w.isFocused()) ?? all[0]
      if (!parent) return undefined
      const page = fallbackPage(
        prompt,
        process.platform,
        text(),
        installPolkitCommand(resourcesPath),
      )
      return askInWindow(parent, page, prompt.name, signal)
    },
    pid: process.pid,
  }
}
