import {
  type CommandHandler,
  cliArgs,
  type ExtensionResult,
  failure,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import { type PortsResult, portsTable } from '../../../shared/remote/remotePorts'
import { jsonArg } from './args'
import type { HostForwards } from './forwards'
import type { RemoteRegistry } from './registry'

export interface PortCommandDeps {
  registry: RemoteRegistry
  forwards: (host: string) => HostForwards | undefined
}

interface PortArgs {
  remote?: number
  local?: number
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value)
  return undefined
}

function portArgs(args: unknown): PortArgs | null {
  const json = jsonArg(args)
  if (Object.keys(json).length > 0) {
    return { remote: numberOf(json.remote), local: numberOf(json.local) }
  }
  const argv = cliArgs(args)?.argv ?? []
  const out: PortArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--local' || word.startsWith('--local=')) {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : argv[++i]
      const local = numberOf(value)
      if (local === undefined) return null
      out.local = local
    } else if (word.startsWith('-')) return null
    else if (out.remote === undefined) {
      const remote = numberOf(word)
      if (remote === undefined) return null
      out.remote = remote
    } else return null
  }
  return out
}

function answer(result: PortsResult): ExtensionResult {
  if (!result.ok) return failure(result.error, result.error)
  return ok(portsTable(result.forwards), { forwards: result.forwards })
}

export function portCommands(
  deps: PortCommandDeps,
): Record<'ports-list' | 'ports-forward' | 'ports-stop', CommandHandler> {
  const forwardsOf = (workspaceId: string | undefined): HostForwards | ExtensionResult => {
    const host = workspaceId ? deps.registry.workspace(workspaceId)?.host : undefined
    if (!host) return failure('not-remote', 'this workspace is not an ssh remote workspace')
    return deps.forwards(host) ?? failure('link-down', 'link-down')
  }
  const guarded =
    (
      run: (forwards: HostForwards, args: PortArgs) => Promise<PortsResult> | PortsResult,
    ): CommandHandler =>
    async (args, caller) => {
      const parsed = portArgs(args)
      if (!parsed) return failure('invalid-args', 'usage: ports-forward <remote> [--local <port>]')
      const forwards = forwardsOf(caller.workspaceId)
      if ('ok' in forwards) return forwards
      return answer(await run(forwards, parsed))
    }
  const needsRemote = (parsed: PortArgs): PortsResult | null =>
    parsed.remote === undefined ? { ok: false, error: 'bad-request' } : null
  return {
    'ports-list': guarded((forwards) => forwards.list()),
    'ports-forward': guarded(
      (forwards, a) => needsRemote(a) ?? forwards.forward(a.remote as number, a.local),
    ),
    'ports-stop': guarded((forwards, a) => needsRemote(a) ?? forwards.stop(a.remote as number)),
  }
}
