import {
  type CommandHandler,
  type ConfirmRequest,
  cliArgs,
  type ExtensionResult,
  failure,
  type OpenTerminalResult,
  ok,
  type Translate,
} from '@aurigax-ai/ostia-extension-sdk'
import type {
  ExtensionCaller,
  OpenTerminalOptions,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { connectConfirm } from './confirm'
import type { HelperBundle } from './helper'
import { ALIAS_PATTERN, type HostList } from './hosts'
import { type ConnectPlan, planConnect, withShellIntegration } from './plan'
import { type Resolved, type RunSsh, resolveTarget } from './target'
import { CONNECT_USAGE, SHOW_USAGE } from './usage'

export interface SshDeps {
  translate: (locale: string | undefined) => Translate
  discover: () => HostList
  run: RunSsh
  confirm: (req: ConfirmRequest) => Promise<boolean>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  shellIntegration: () => Promise<boolean>
  sessionOpened?: (paneId: string, plan: ConnectPlan) => void
  installedHelper?: (plan: ConnectPlan) => Promise<HelperBundle | null>
}

type Unresolved = Exclude<Resolved, { ok: true }>

function resolveFailure(failed: Unresolved, t: Translate): ExtensionResult {
  if (failed.error === 'ssh-missing') return failure('ssh-missing', t('sshMissing'))
  return failure('resolve-failed', t('resolveFailed', { reason: failed.reason ?? t('timedOut') }))
}

function argvOf(args: unknown): string[] {
  return cliArgs(args)?.argv ?? []
}

export function sshCommands(deps: SshDeps): Record<'ls' | 'show' | 'connect', CommandHandler> {
  const sandboxed = (caller: ExtensionCaller, t: Translate): ExtensionResult | null =>
    caller.sandboxed ? failure('sandboxed', t('sandboxed')) : null

  return {
    ls: async (_args, caller) => {
      const refused = sandboxed(caller, deps.translate(caller.locale))
      if (refused) return refused
      const { hosts, truncated } = deps.discover()
      return ok(undefined, { hosts: hosts.map((alias) => ({ alias })), truncated })
    },

    show: async (args, caller) => {
      const t = deps.translate(caller.locale)
      const refused = sandboxed(caller, t)
      if (refused) return refused
      const argv = argvOf(args)
      if (argv.length !== 1 || !ALIAS_PATTERN.test(argv[0])) {
        return failure('invalid-args', SHOW_USAGE)
      }
      const resolved = await resolveTarget(argv[0], deps.run)
      if (!resolved.ok) return resolveFailure(resolved, t)
      return ok(undefined, resolved.target)
    },

    connect: async (args, caller) => {
      const t = deps.translate(caller.locale)
      const refused = sandboxed(caller, t)
      if (refused) return refused
      const planned = planConnect(argvOf(args))
      if (!planned) return failure('invalid-args', CONNECT_USAGE)
      const resolved = await resolveTarget(planned.destination, deps.run)
      if (!resolved.ok) return resolveFailure(resolved, t)
      const integrates = !resolved.target.remoteCommand && (await deps.shellIntegration())
      const helper = integrates ? ((await deps.installedHelper?.(planned)) ?? undefined) : undefined
      const plan = integrates ? withShellIntegration(planned, helper) : planned
      const { command, shellIntegration } = plan
      if (caller.kind === 'pane') {
        const approved = await deps.confirm(connectConfirm(plan, resolved.target, t))
        if (!approved) {
          return {
            ok: false,
            error: 'denied',
            message: t('denied'),
            data: { approved: false, command },
          }
        }
      }
      const opened = await deps.openTerminal({
        command: plan.argv,
        workspaceId: caller.workspaceId,
        afterPaneId: caller.paneId,
        title: plan.destination,
      })
      if (!opened.ok) {
        return {
          ok: false,
          error: 'not-opened',
          message: t('notOpened', { reason: opened.message ?? opened.error }),
          data: { approved: true, command, shellIntegration },
        }
      }
      deps.sessionOpened?.(opened.paneId, planned)
      return ok(undefined, { approved: true, command, shellIntegration, paneId: opened.paneId })
    },
  }
}
