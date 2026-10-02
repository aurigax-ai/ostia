import type { ExtensionCaller, OpenTerminalOptions } from '../../shared/extensions'
import {
  type CommandHandler,
  type ConfirmRequest,
  type ExtensionResult,
  type OpenTerminalResult,
  cliArgs,
  failure,
  ok,
} from '../sdk'
import { connectConfirm } from './confirm'
import { ALIAS_PATTERN, type HostList } from './hosts'
import { planConnect, withShellIntegration } from './plan'
import { CONNECT_USAGE, SHOW_USAGE, type Strings, stringsFor } from './strings'
import { type Resolved, type RunSsh, resolveTarget } from './target'

export interface SshDeps {
  discover: () => HostList
  run: RunSsh
  confirm: (req: ConfirmRequest) => Promise<boolean>
  openTerminal: (opts: OpenTerminalOptions) => Promise<OpenTerminalResult>
  shellIntegration: () => Promise<boolean>
}

type Unresolved = Exclude<Resolved, { ok: true }>

function resolveFailure(failed: Unresolved, s: Strings): ExtensionResult {
  if (failed.error === 'ssh-missing') return failure('ssh-missing', s.sshMissing)
  return failure('resolve-failed', s.resolveFailed(failed.reason ?? s.timedOut))
}

function argvOf(args: unknown): string[] {
  return cliArgs(args)?.argv ?? []
}

export function sshCommands(deps: SshDeps): Record<'ls' | 'show' | 'connect', CommandHandler> {
  const sandboxed = (caller: ExtensionCaller, s: Strings): ExtensionResult | null =>
    caller.sandboxed ? failure('sandboxed', s.sandboxed) : null

  return {
    ls: async (_args, caller) => {
      const refused = sandboxed(caller, stringsFor(caller.locale))
      if (refused) return refused
      const { hosts, truncated } = deps.discover()
      return ok(undefined, { hosts: hosts.map((alias) => ({ alias })), truncated })
    },

    show: async (args, caller) => {
      const s = stringsFor(caller.locale)
      const refused = sandboxed(caller, s)
      if (refused) return refused
      const argv = argvOf(args)
      if (argv.length !== 1 || !ALIAS_PATTERN.test(argv[0])) {
        return failure('invalid-args', SHOW_USAGE)
      }
      const resolved = await resolveTarget(argv[0], deps.run)
      if (!resolved.ok) return resolveFailure(resolved, s)
      return ok(undefined, resolved.target)
    },

    connect: async (args, caller) => {
      const s = stringsFor(caller.locale)
      const refused = sandboxed(caller, s)
      if (refused) return refused
      const planned = planConnect(argvOf(args))
      if (!planned) return failure('invalid-args', CONNECT_USAGE)
      const resolved = await resolveTarget(planned.destination, deps.run)
      if (!resolved.ok) return resolveFailure(resolved, s)
      const integrates = !resolved.target.remoteCommand && (await deps.shellIntegration())
      const plan = integrates ? withShellIntegration(planned) : planned
      const { command, shellIntegration } = plan
      if (caller.kind === 'pane') {
        const approved = await deps.confirm(connectConfirm(plan, resolved.target, s))
        if (!approved) {
          return {
            ok: false,
            error: 'denied',
            message: s.denied,
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
          message: s.notOpened(opened.message ?? opened.error),
          data: { approved: true, command, shellIntegration },
        }
      }
      return ok(undefined, { approved: true, command, shellIntegration, paneId: opened.paneId })
    },
  }
}
