import { OPEN_TERMINAL_WAIT_MAX_MS, type TerminalWait } from '../../shared/extensions'
import { quoteArgv } from '../../shared/shellQuote'
import {
  MANAGER_NAMES,
  MAX_PACKAGES,
  type ManagerName,
  defaultManager,
  installArgv,
  invalidPackages,
  isManagerName,
} from './managers'
import type { OsIdentity } from './os'
import type { Strings } from './strings'

export const REASON_MAX = 500
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
  const packages: string[] = []
  const request: InstallRequest = { packages }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--wait') {
      request.wait = true
    } else if ((arg === '--manager' || arg === '--reason') && i + 1 < argv.length) {
      const value = argv[++i]
      if (arg === '--manager') request.manager = value
      else request.reason = value
    } else {
      packages.push(arg)
    }
  }
  return request
}

export function planInstall(req: InstallRequest, ctx: InstallContext, s: Strings): PlanResult {
  if (req.packages.length === 0) return { ok: false, error: 'invalid-args', message: s.noPackages }
  if (req.packages.length > MAX_PACKAGES) {
    return { ok: false, error: 'invalid-args', message: s.tooManyPackages(MAX_PACKAGES) }
  }
  const bad = invalidPackages(req.packages)
  if (bad.length > 0) {
    return { ok: false, error: 'invalid-package', message: s.invalidPackages(bad) }
  }
  let manager: ManagerName
  if (req.manager !== undefined) {
    if (!isManagerName(req.manager)) {
      return {
        ok: false,
        error: 'unknown-manager',
        message: s.unknownManager(req.manager, [...MANAGER_NAMES]),
      }
    }
    if (!ctx.available.includes(req.manager)) {
      return { ok: false, error: 'manager-missing', message: s.managerMissing(req.manager) }
    }
    manager = req.manager
  } else {
    const found = defaultManager(ctx.os, ctx.available)
    if (!found) return { ok: false, error: 'no-manager', message: s.noManager }
    manager = found
  }
  const built = installArgv(manager, req.packages, { isRoot: ctx.isRoot })
  if (!built.ok) return { ok: false, error: built.error, message: s.onePackageOnly(manager) }
  if (built.argv[0] === 'sudo' && !ctx.hasSudo) {
    return { ok: false, error: 'no-sudo', message: s.noSudo }
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

export function installOutcome(wait: TerminalWait, s: Strings): InstallOutcome {
  if (wait.outcome === 'timeout') return { ok: true, message: s.installStillRunning }
  if (wait.outcome === 'closed')
    return { ok: false, error: 'terminal-closed', message: s.installClosed }
  if (wait.exitCode === 0) return { ok: true, message: s.installed }
  return { ok: false, error: 'install-failed', message: s.installFailed(wait.exitCode) }
}

export function installWaitMs(startedAt: number, now: number): number {
  return Math.max(INSTALL_WAIT_MIN_MS, INSTALL_WAIT_BUDGET_MS - (now - startedAt))
}
