import { parseFlags, type Translate } from '@aurigax-ai/ostia-extension-sdk'
import {
  OPEN_TERMINAL_WAIT_MAX_MS,
  type TerminalWait,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import {
  defaultManager,
  installArgv,
  invalidPackages,
  isManagerName,
  MANAGER_NAMES,
  MAX_PACKAGES,
  type ManagerName,
} from './managers'
import type { OsIdentity } from './os'

const REASON_MAX = 500
const INSTALL_WAIT_BUDGET_MS = OPEN_TERMINAL_WAIT_MAX_MS - 30_000
const INSTALL_WAIT_MIN_MS = 1000

export interface InstallRequest {
  packages: string[]
  manager?: string
  reason?: string
  wait?: boolean
}

export interface InstallContext {
  os: OsIdentity
  available: ManagerName[]
  isRoot: boolean
  hasSudo: boolean
}

export interface InstallPlan {
  manager: ManagerName
  packages: string[]
  argv: string[]
  command: string
  reason?: string
}

export type PlanResult =
  | { ok: true; plan: InstallPlan }
  | { ok: false; error: string; message: string }

export function parseInstallArgs(argv: string[]): InstallRequest {
  const { flags, bools, rest } = parseFlags(argv, ['manager', 'reason'], ['wait'])
  const request: InstallRequest = { packages: rest }
  if (flags.manager !== undefined) request.manager = flags.manager
  if (flags.reason !== undefined) request.reason = flags.reason
  if (bools.has('wait')) request.wait = true
  return request
}

export function planInstall(req: InstallRequest, ctx: InstallContext, t: Translate): PlanResult {
  if (req.packages.length === 0)
    return { ok: false, error: 'invalid-args', message: t('noPackages') }
  if (req.packages.length > MAX_PACKAGES) {
    return {
      ok: false,
      error: 'invalid-args',
      message: t('tooManyPackages', { max: MAX_PACKAGES }),
    }
  }
  const bad = invalidPackages(req.packages)
  if (bad.length > 0) {
    return {
      ok: false,
      error: 'invalid-package',
      message: t('invalidPackages', { names: bad.join(t('listSeparator')) }),
    }
  }
  let manager: ManagerName
  if (req.manager !== undefined) {
    if (!isManagerName(req.manager)) {
      return {
        ok: false,
        error: 'unknown-manager',
        message: t('unknownManager', { name: req.manager, known: [...MANAGER_NAMES].join(', ') }),
      }
    }
    if (!ctx.available.includes(req.manager)) {
      return {
        ok: false,
        error: 'manager-missing',
        message: t('managerMissing', { name: req.manager }),
      }
    }
    manager = req.manager
  } else {
    const found = defaultManager(ctx.os, ctx.available)
    if (!found) return { ok: false, error: 'no-manager', message: t('noManager') }
    manager = found
  }
  const built = installArgv(manager, req.packages, { isRoot: ctx.isRoot })
  if (!built.ok) return { ok: false, error: built.error, message: t('onePackageOnly', { manager }) }
  if (built.argv[0] === 'sudo' && !ctx.hasSudo) {
    return { ok: false, error: 'no-sudo', message: t('noSudo') }
  }
  const plan: InstallPlan = {
    manager,
    packages: req.packages,
    argv: built.argv,
    command: quoteArgv(built.argv),
  }
  const reason = req.reason?.trim().slice(0, REASON_MAX)
  if (reason) plan.reason = reason
  return { ok: true, plan }
}

type InstallOutcome =
  | { ok: true; message: string }
  | { ok: false; error: 'install-failed' | 'terminal-closed'; message: string }

export function installOutcome(wait: TerminalWait, t: Translate): InstallOutcome {
  if (wait.outcome === 'timeout') return { ok: true, message: t('installStillRunning') }
  if (wait.outcome === 'closed')
    return { ok: false, error: 'terminal-closed', message: t('installClosed') }
  if (wait.exitCode === 0) return { ok: true, message: t('installed') }
  return {
    ok: false,
    error: 'install-failed',
    message: t('installFailed', { code: wait.exitCode ?? t('exitUnknown') }),
  }
}

export function installWaitMs(startedAt: number, now: number): number {
  return Math.max(INSTALL_WAIT_MIN_MS, INSTALL_WAIT_BUDGET_MS - (now - startedAt))
}
