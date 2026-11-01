import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import type { BrowseOutcome } from '../../shared/browser/browseRuntime'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import type { Reach } from '../approvals/reach'
import type { AuthedConn } from '../control/controlAuth'
import type { PaneIdentity } from '../control/idRegistry'
import { reportError } from '../diagnostics/errorReport'
import { resolveSafe } from '../platform/pathGuard'
import { privateTmpDir } from '../platform/privateTmp'
import { runInBrowseWorld } from './browseWorld'

export type MethodCtx = { identity: PaneIdentity; authed: AuthedConn }

export interface BrowseDeps {
  browserPanes: Map<string, number>
  isSharedPane: (paneId: string) => boolean
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  screenshotRoots: string[]
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  allowNavigation: (workspaceId: string, url: string) => Promise<boolean>
  reach: Pick<Reach, 'inScope'>
}

export interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

const DEFAULT_TIMEOUT_MS = 25_000
export const MAX_TIMEOUT_MS = 120_000
const POLL_MS = 100

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function fail(
  error: string,
  message?: string,
): { ok: false; error: string; message?: string } {
  return message ? { ok: false, error, message } : { ok: false, error }
}

export type Params = Record<string, unknown>

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function clampTimeout(value: unknown): number {
  const ms = num(value) ?? DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MS)
}

export function world<T extends object>(
  guest: Electron.WebContents,
  call: string,
): Promise<BrowseOutcome<T>> {
  return runInBrowseWorld<BrowseOutcome<T>>(guest, call)
}

export async function debuggerCommand<T = unknown>(
  guest: Electron.WebContents,
  method: string,
  params?: object,
): Promise<T> {
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
  return (await guest.debugger.sendCommand(method, params)) as T
}

export function commandTarget(identity: PaneIdentity): CommandTarget {
  return { windowId: identity.windowId, workspaceId: identity.workspaceId, paneId: identity.paneId }
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let failure: unknown
  for (;;) {
    try {
      if (await check()) return true
    } catch (err) {
      failure = err
    }
    if (Date.now() >= deadline) {
      if (failure !== undefined) reportError('browseWait', failure)
      return false
    }
    await sleep(POLL_MS)
  }
}

export function safeOutPath(
  deps: Pick<BrowseDeps, 'screenshotRoots'>,
  path: string,
): string | null {
  return resolveSafe(path, deps.screenshotRoots)
}

let scratchCounter = 0

export function scratchPath(prefix: string, ext: string): string {
  scratchCounter += 1
  return join(
    privateTmpDir(`${PRODUCT_NAME}-screens`),
    `${prefix}-${Date.now()}-${scratchCounter}.${ext}`,
  )
}

export function writeOut(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
}

export type BrowseMethod = (
  name: string,
  run: (
    guest: Electron.WebContents,
    p: Params,
    ctx: MethodCtx,
    rendererPaneId: string,
  ) => unknown | Promise<unknown>,
) => void

export type OpenTab = (ctx: MethodCtx, url: string, background: boolean) => Promise<unknown>
