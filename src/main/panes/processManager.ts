import { basename } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { ChangeSignal } from '../../shared/common/actThenConfirm'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import type { Reach } from '../approvals/reach'
import {
  type ControlMethodContext,
  registerControlMethod,
  registerTargetableMethod,
} from '../control/controlServer'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import { paneNamed } from './paneNames'
import { record } from './paneReach'
import { paneSight } from './paneRef'
import { type PhoneAgent, phoneAgentCommand } from './phoneAgent'
import { createProcessControl, type ProcessControlDeps } from './processControl'
import {
  agentOf,
  badRequest,
  commandOf,
  createProcessLauncher,
  cwdOf,
  defaultName,
  modelFlags,
  nameOf,
  type ProcessLaunchDeps,
  promptOf,
  splitTabOf,
  workspaceOf,
} from './processLaunch'
import { type ProcessEntry, ProcessRegistry, type StartOutcome } from './processRegistry'

export const INTERRUPT_GRACE_MS = 3000

export function processStatusOf(entry: ProcessEntry): {
  id: string
  status: string
  start?: StartOutcome
} {
  const status =
    entry.status === 'exited' && entry.exitCode !== undefined
      ? `exited(${entry.exitCode})`
      : entry.status
  return { id: entry.id, status, ...(entry.start ? { start: entry.start } : {}) }
}

export interface ProcessDeps extends ProcessLaunchDeps, ProcessControlDeps {
  hasShell: (paneId: string) => boolean
  runInPane: (paneId: string, command: string) => boolean
  agentArgv: (name: string) => string[] | null
  startsWithHook: (argv: readonly string[]) => boolean
  isConfined: (paneId: string) => boolean
  reach: Pick<Reach, 'ensure' | 'visible' | 'scriptReach'>
  managerAdmitSpawn: (liveWorkers: number) => string | null
  isScratch: (workspaceId: string) => boolean
}

const NOT_FOUND = { ok: false as const, error: 'not-found' as const }
const REMOTE_WORKSPACE = {
  ok: false as const,
  error: 'remote-workspace' as const,
  message: 'a remote workspace never runs a command locally; use agent run or open a tab in it',
}
const UNKNOWN_AGENT = {
  ok: false as const,
  error: 'unknown-agent' as const,
  message: `${PRODUCT_DISPLAY_NAME} knows no agent by that name; start it with ostia process run instead`,
}

const CLOSED = {
  ok: false as const,
  error: 'closed' as const,
  message: 'its tab was closed; start it again with ostia process run',
}

export type PhoneAgentStart = { paneId: string; started: boolean; confirmed: boolean } | null

export function registerProcessMethods(deps: ProcessDeps): {
  registry: ProcessRegistry
  startAgentForPhone: (
    workspaceId: string,
    agent: PhoneAgent,
    prompt: string,
  ) => Promise<PhoneAgentStart>
} {
  const registryChanges = new ChangeSignal()
  const registry = new ProcessRegistry({
    ring: deps.ring,
    workspaceOfPane: (paneId) => getByPaneId(paneId)?.workspaceId,
    now: () => new Date(),
    onChange: (entry) => {
      deps.onChange?.(entry)
      registryChanges.fire()
    },
  })

  const { scriptReach, find, interrupt, endShell } = createProcessControl({ ...deps, registry })
  const { runInTab, runRemote, workersTab, openAndConfirm } = createProcessLauncher({
    ...deps,
    registry,
    registryChanges,
  })

  const startAgentForPhone = async (
    workspaceId: string,
    agent: PhoneAgent,
    prompt: string,
  ): Promise<PhoneAgentStart> => {
    const command = phoneAgentCommand(agent, prompt)
    if (!command) return null
    const confirmed = deps.startsWithHook([agent])
    const started = await openAndConfirm({ command, workspaceId, title: agent }, '', confirmed)
    if (!started) return null
    return {
      paneId: started.entry.externalPaneId,
      started: started.report.status === 'started',
      confirmed,
    }
  }

  const tabName = async (raw: unknown, ctx: ControlMethodContext): Promise<string | undefined> => {
    const name = nameOf(raw)
    if (name === undefined) return undefined
    const holder = getByPaneId(paneNamed(name) ?? '')
    if (holder) {
      const sees = await paneSight({ ...deps, visible: deps.reach.visible }, ctx)
      const by = sees(holder) ? holder.externalId : 'another pane'
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        `name-taken: ${name} is a bus name held by ${by}`,
      )
    }
    return name
  }

  registerControlMethod('process.run', {
    cap: 'process',
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const cmd = commandOf(p.cmd)
      const target = workspaceOf(p.workspace) ?? ctx.identity.workspaceId
      if (target && (await deps.remote?.isRemote(target))) return REMOTE_WORKSPACE
      return runInTab(
        ctx,
        cmd,
        (await tabName(p.name, ctx)) ?? defaultName(cmd),
        cwdOf(p.cwd),
        workspaceOf(p.workspace),
        splitTabOf(p.tab),
        false,
        true,
      )
    },
  })

  const recordOwner = (ctx: ControlMethodContext, started: unknown): void => {
    const caller = ctx.identity
    const paneId = record(started).paneId
    if (caller.kind !== 'pane' || caller.manager || typeof paneId !== 'string') return
    if (deps.isSandboxed(caller.workspaceId) || deps.isScratch(caller.workspaceId)) return
    const child = resolveExternal(paneId)
    if (child?.kind === 'pane') registry.adoptChild(caller.paneId, child.paneId)
  }

  registerControlMethod('agent.run', {
    cap: 'process',
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const agent = agentOf(p.agent)
      const argv = deps.agentArgv(agent)
      if (!argv) return UNKNOWN_AGENT
      if (ctx.identity.manager) {
        const refused = deps.managerAdmitSpawn(registry.openedBy(ctx.identity.paneId).length)
        if (refused) throw new ResponseError(ErrorCodes.InvalidRequest, refused)
      }
      const cmd = commandOf(quoteArgv([...argv, ...modelFlags(argv, p.model), promptOf(p.prompt)]))
      const title = (await tabName(p.name, ctx)) ?? agent
      const remote = await runRemote(ctx, workspaceOf(p.workspace), {
        agent,
        prompt: promptOf(p.prompt),
        ...(typeof p.model === 'string' ? { model: p.model } : {}),
        title,
      })
      if (remote) return remote
      const started = await runInTab(
        ctx,
        cmd,
        title,
        cwdOf(p.cwd),
        workspaceOf(p.workspace),
        splitTabOf(p.tab) ??
          (await workersTab(ctx, workspaceOf(p.workspace) ?? ctx.identity.workspaceId)),
        deps.startsWithHook(argv),
        p.tab !== undefined && p.tab !== null,
        basename(argv[0] ?? '') === 'claude',
      )
      recordOwner(ctx, started)
      return started
    },
  })

  registerTargetableMethod('process.list', {
    cap: 'process',
    scripts: true,
    handler: async (_params, ctx) => {
      await scriptReach(ctx, 'process.list')
      const reaches = await deps.reach.visible(ctx)
      const home = ctx.identity.workspaceId
      return registry
        .list(null)
        .filter((entry) => {
          const owner = registry.workspaceOf(entry)
          return owner === home || reaches(owner)
        })
        .map((entry) => registry.info(entry))
    },
  })

  registerTargetableMethod('process.info', {
    cap: 'process',
    scripts: true,
    handler: async (params, ctx) => {
      const entry = await find(params, ctx, 'process.info')
      return entry ? registry.info(entry) : NOT_FOUND
    },
  })

  registerTargetableMethod('process.output', {
    cap: 'process',
    scripts: true,
    handler: async (params, ctx) => {
      const entry = await find(params, ctx, 'process.output')
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      const since = Number(record(params).sinceCursor ?? 0)
      if (!Number.isFinite(since) || since < 0) throw badRequest('sinceCursor')
      return (
        registry.output(entry, since) ?? {
          ok: false,
          error: 'no-output',
          message: 'the terminal no longer holds this output',
        }
      )
    },
  })

  registerControlMethod('process.kill', {
    cap: 'process',
    scripts: true,
    handler: async (params, ctx) => {
      const entry = await find(params, ctx, 'process.kill')
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      if (entry.status === 'exited') return { ok: true, status: entry.status }
      if (!(await interrupt(entry))) endShell(entry)
      return { ok: true, status: entry.status, exitCode: entry.exitCode }
    },
  })

  registerControlMethod('process.restart', {
    cap: 'process',
    scripts: true,
    handler: async (params, ctx) => {
      const entry = await find(params, ctx, 'process.restart')
      if (!entry) return NOT_FOUND
      if (entry.status === 'closed') return CLOSED
      if (!deps.hasShell(entry.paneId)) {
        return {
          ok: false,
          error: 'no-shell',
          message: "its tab's shell has ended; start it again with ostia process run",
        }
      }
      if (entry.status === 'starting') return { id: entry.id, name: entry.name }
      if (!(await interrupt(entry))) {
        return {
          ok: false,
          error: 'still-running',
          message: 'the command did not stop on interrupt; stop it with ostia process kill',
        }
      }
      registry.rerun(entry)
      if (!deps.runInPane(entry.paneId, entry.cmd)) {
        return { ok: false, error: 'no-window', message: 'the tab has no window to run it in' }
      }
      return { id: entry.id, name: entry.name, paneId: entry.externalPaneId }
    },
  })

  return { registry, startAgentForPhone }
}
