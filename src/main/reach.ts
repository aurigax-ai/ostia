import type { ApprovalOutcome } from '../shared/approvals'
import type { ReachMode } from '../shared/reach'
import type { WorkspaceSandbox } from '../shared/sandbox'
import type { ApprovalAsk } from './approvals'
import { connHasCap } from './controlAuth'
import { ensureCaps } from './controlElevation'
import type { ControlMethodContext } from './controlServer'
import {
  GroupProvenance,
  type ScopeWorkspace,
  projectKey,
  sameReachScope,
  unconfirmedGroupMembers,
} from './reachScope'

export type ReachCaller = Pick<ControlMethodContext, 'identity' | 'authed'>

export interface ReachGroupListing {
  workspaces: { workspaceId: string; name: string; groupId?: string }[]
  groups: { groupId: string; name: string }[]
}

export interface ReachDeps {
  mode: () => ReachMode
  home: string
  workDir: (workspaceId: string) => string | undefined
  isScratch: (workspaceId: string) => boolean
  hasManager: (workspaceId: string) => boolean
  sandbox: (workspaceId: string) => WorkspaceSandbox
  groups: () => Promise<ReachGroupListing>
  ask: (ask: ApprovalAsk) => Promise<ApprovalOutcome> | null
}

export interface Reach {
  inScope: (ctx: ReachCaller, workspaceId: string) => Promise<boolean>
  ensure: (ctx: ReachCaller, workspaceId: string, action: string, detail: string) => Promise<void>
  visible: (ctx: ReachCaller) => Promise<(workspaceId: string) => boolean>
  byAgent: <T>(run: () => Promise<T>) => Promise<T>
  forget: (workspaceId: string) => void
}

const NO_GROUPS: ReachGroupListing = { workspaces: [], groups: [] }

export function createReach(deps: ReachDeps): Reach {
  const provenance = new GroupProvenance()

  const listing = async (mode: ReachMode): Promise<ReachGroupListing> =>
    mode === 'group' ? await deps.groups().catch(() => NO_GROUPS) : NO_GROUPS

  const factsOf = (workspaceId: string, groups: ReachGroupListing): ScopeWorkspace => {
    const workDir = deps.workDir(workspaceId)
    const groupId = groups.workspaces.find((w) => w.workspaceId === workspaceId)?.groupId
    return {
      id: workspaceId,
      shareable:
        workDir !== undefined && !deps.isScratch(workspaceId) && !deps.hasManager(workspaceId),
      project: workDir === undefined ? null : projectKey(workDir, deps.home),
      sandbox: deps.sandbox(workspaceId),
      group: groupId ? { id: groupId, byAgent: provenance.byAgent(workspaceId, groupId) } : null,
    }
  }

  const confirmMembership = async (
    ctx: ReachCaller,
    workspaceId: string,
    groups: ReachGroupListing,
  ): Promise<boolean> => {
    const me = ctx.identity
    if (me.kind !== 'pane' || me.externalId !== ctx.authed.externalId) return false
    const entry = groups.workspaces.find((w) => w.workspaceId === workspaceId)
    const group = groups.groups.find((g) => g.groupId === entry?.groupId)
    const pending = deps.ask({
      externalId: ctx.authed.externalId,
      windowId: me.windowId,
      paneId: me.paneId,
      workspaceId: me.workspaceId,
      caps: [],
      kind: 'reach-group',
      subject: entry?.name ?? workspaceId,
      action: 'reach',
      detail: `workspace ${workspaceId} in group ${JSON.stringify(group?.name ?? '')}`,
    })
    if (!pending || (await pending) !== 'workspace') return false
    provenance.confirm(workspaceId)
    return true
  }

  const inScope = async (ctx: ReachCaller, workspaceId: string): Promise<boolean> => {
    const callerId = ctx.identity.workspaceId
    if (!callerId || !workspaceId) return false
    if (callerId === workspaceId) return true
    const mode = deps.mode()
    const groups = await listing(mode)
    const caller = factsOf(callerId, groups)
    const target = factsOf(workspaceId, groups)
    if (sameReachScope(caller, target, mode)) return true
    if (connHasCap(ctx.authed, 'all-workspaces')) return false
    for (const id of unconfirmedGroupMembers(caller, target, mode)) {
      if (!(await confirmMembership(ctx, id, groups))) return false
    }
    return sameReachScope(factsOf(callerId, groups), factsOf(workspaceId, groups), mode)
  }

  const ensure = async (
    ctx: ReachCaller,
    workspaceId: string,
    action: string,
    detail: string,
  ): Promise<void> => {
    if (await inScope(ctx, workspaceId)) return
    await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], action, detail)
  }

  const visible = async (ctx: ReachCaller): Promise<(workspaceId: string) => boolean> => {
    if (connHasCap(ctx.authed, 'all-workspaces')) return () => true
    const callerId = ctx.identity.workspaceId
    const mode = deps.mode()
    const groups = await listing(mode)
    const caller = callerId ? factsOf(callerId, groups) : null
    return (workspaceId) =>
      caller !== null && sameReachScope(caller, factsOf(workspaceId, groups), mode)
  }

  const byAgent = async <T>(run: () => Promise<T>): Promise<T> => {
    const before = await deps.groups().catch(() => null)
    try {
      return await run()
    } finally {
      const after = await deps.groups().catch(() => null)
      for (const w of after?.workspaces ?? []) {
        const was = before?.workspaces.find((b) => b.workspaceId === w.workspaceId)
        if (w.groupId && (!before || was?.groupId !== w.groupId)) {
          provenance.placedByAgent(w.workspaceId, w.groupId)
        }
      }
    }
  }

  return {
    inScope,
    ensure,
    visible,
    byAgent,
    forget: (workspaceId) => provenance.forget(workspaceId),
  }
}
