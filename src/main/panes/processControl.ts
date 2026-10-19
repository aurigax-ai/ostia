import { ensureCaps } from '../approvals/controlElevation'
import type { Reach } from '../approvals/reach'
import type { ControlMethodContext } from '../control/controlServer'
import { record } from './paneReach'
import { badRequest } from './processLaunch'
import type { ProcessEntry, ProcessRegistry, RingReader } from './processRegistry'

const INTERRUPT = '\x03'

export interface ProcessControlDeps {
  ring: (paneId: string) => RingReader | undefined
  writePane: (paneId: string, data: string) => boolean
  endShell: (paneId: string) => void
  reach: Pick<Reach, 'visible' | 'scriptReach'>
  interruptGraceMs: number
}

export function createProcessControl(deps: ProcessControlDeps & { registry: ProcessRegistry }) {
  const { registry } = deps

  const scriptReach = async (ctx: ControlMethodContext, method: string): Promise<void> => {
    if (ctx.identity.kind !== 'script' || (await deps.reach.scriptReach(ctx))) return
    await ensureCaps(
      ctx.authed,
      ctx.identity,
      ['all-workspaces'],
      method,
      'processes of every workspace',
    )
  }

  const find = async (
    raw: unknown,
    ctx: ControlMethodContext,
    method: string,
  ): Promise<ProcessEntry | undefined> => {
    const { id } = record(raw)
    if (ctx.identity.kind === 'script' && (typeof id !== 'string' || !id)) throw badRequest('id')
    await scriptReach(ctx, method)
    return typeof id === 'string'
      ? registry.resolve(id, ctx.identity.workspaceId, await deps.reach.visible(ctx))
      : undefined
  }

  const interrupt = async (entry: ProcessEntry): Promise<boolean> => {
    if (entry.status !== 'running') return entry.status !== 'starting'
    deps.writePane(entry.paneId, INTERRUPT)
    return registry.waitForExit(entry, deps.interruptGraceMs)
  }

  const endShell = (entry: ProcessEntry): void => {
    const ring = deps.ring(entry.paneId)
    deps.endShell(entry.paneId)
    registry.shellEnded(entry.paneId, ring ?? (() => ({ data: '', cursor: 0, dropped: false })))
  }

  return { scriptReach, find, interrupt, endShell }
}
