import { constants, accessSync, readFileSync, statSync } from 'node:fs'
import { arch, release } from 'node:os'
import {
  type CommandHandler,
  type ExtensionCaller,
  type ExtensionResult,
  cliArgs,
  connect,
  failure,
  ok,
  runTool,
} from '../sdk'
import { type InstallContext, parseInstallArgs, planInstall } from './install'
import { MANAGER_NAMES, type ManagerName, defaultManager, findOnPath } from './managers'
import { type OsIdentity, parseOsRelease, parseSwVers, windowsRelease } from './os'
import { stringsFor } from './strings'

const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release']
const INSTALL_USAGE = 'install <pkg...> [--manager <name>] [--reason <text>]'

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function detectOs(): Promise<OsIdentity> {
  const platform = process.platform
  if (platform === 'linux') {
    for (const file of OS_RELEASE_FILES) {
      try {
        return { platform, ...parseOsRelease(readFileSync(file, 'utf8')) }
      } catch {}
    }
    return { platform, id: 'linux', idLike: [], name: 'Linux', version: '' }
  }
  if (platform === 'darwin') {
    const run = await runTool('sw_vers', [], { timeoutMs: 5000 })
    return { platform, ...parseSwVers(run.stdout) }
  }
  if (platform === 'win32') return { platform, ...windowsRelease(release()) }
  return { platform, id: platform, idLike: [], name: platform, version: release() }
}

function onPath(name: string): boolean {
  const env = {
    path: process.env.PATH ?? '',
    platform: process.platform,
    pathExt: process.env.PATHEXT,
  }
  return findOnPath(name, env, isExecutable) !== null
}

async function installContext(): Promise<InstallContext> {
  return {
    os: await detectOs(),
    available: MANAGER_NAMES.filter((m): m is ManagerName => onPath(m)),
    isRoot: process.getuid?.() === 0,
    hasSudo: onPath('sudo'),
  }
}

function defaultShell(): string | null {
  return process.env.SHELL || process.env.ComSpec || null
}

async function main(): Promise<void> {
  const ext = await connect()

  const install = async (args: unknown, caller: ExtensionCaller): Promise<ExtensionResult> => {
    const s = stringsFor(caller.locale)
    const parsed = cliArgs(args)
    if (!parsed) return failure('invalid-args', INSTALL_USAGE)
    const planned = planInstall(parseInstallArgs(parsed.argv), await installContext(), s)
    if (!planned.ok) return failure(planned.error, planned.message)
    const { plan } = planned
    const approved = await ext.confirm({
      title: s.confirmTitle,
      message: s.confirmMessage(plan.packages, plan.manager),
      detail: s.confirmDetail(plan.command, plan.reason),
      confirmLabel: s.approve,
      cancelLabel: s.deny,
    })
    if (!approved) {
      return {
        ok: false,
        error: 'denied',
        message: s.denied,
        data: { approved: false, command: plan.command },
      }
    }
    const opened = await ext.openTerminal({
      command: plan.argv,
      workspaceId: caller.workspaceId,
      afterPaneId: caller.paneId,
      cwd: caller.cwd,
      title: s.terminalTitle,
    })
    if (!opened.ok) {
      return {
        ok: false,
        error: 'not-opened',
        message: s.notOpened(opened.message ?? opened.error),
        data: { approved: true, command: plan.command },
      }
    }
    return ok(undefined, { approved: true, command: plan.command, paneId: opened.paneId })
  }

  const handlers: Record<string, CommandHandler> = {
    info: async () => {
      const ctx = await installContext()
      return ok(undefined, {
        os: ctx.os,
        kernel: release(),
        arch: arch(),
        shell: defaultShell(),
        isRoot: ctx.isRoot,
        packageManagers: {
          available: ctx.available,
          default: defaultManager(ctx.os, ctx.available),
        },
      })
    },
    install,
  }

  await ext.registerCommands(handlers)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
