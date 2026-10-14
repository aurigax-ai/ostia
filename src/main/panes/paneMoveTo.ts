import type { CommandResult, PaneMoveError } from '../../shared/types'
import { normalizeSplitTabName } from '../../shared/workspaces/splitTabs'
import type { Reach } from '../approvals/reach'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, getByPaneId } from '../control/idRegistry'
import { type PaneReachDeps, ensurePaneReach, fail, paneRefs, paneTarget, record } from './paneIo'
import { type PaneMoveDeps, checkPaneMove } from './paneMove'

interface PaneTabPlan {
  members: string[]
  locked: string[]
}

export interface PaneMoveToDeps extends PaneReachDeps, Omit<PaneMoveDeps, 'movePanes'> {
  ensureReach: Reach['ensure']
  move: (pane: PaneIdentity, workspaceId: string) => Promise<CommandResult>
  tabPlan: (workspaceId: string, paneIds: string[], tab: string | null) => Promise<CommandResult>
  joinTab: (workspaceId: string, paneIds: string[], tab: string | null) => Promise<CommandResult>
}

const REFUSALS: Readonly<Record<PaneMoveError, string>> = {
  'not-owned': 'other-window: the pane and the workspace are in different windows',
  manager: 'unknown-pane: no such pane',
  scratch: 'scratch: a pane never moves into or out of a scratch workspace',
  sandbox: 'sandboxed: a pane never moves into or out of a sandboxed workspace',
}

const NEW_TAB = 'new'

function tabOf(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (raw === NEW_TAB) return null
  const name = normalizeSplitTabName(raw)
  if (!name) throw fail('bad-request: tab')
  return name
}

function workspaceOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: workspace')
  return raw
}

function byWorkspace(panes: PaneIdentity[], workspace: string | undefined) {
  const groups = new Map<string, PaneIdentity[]>()
  for (const to of panes) {
    const dest = workspace ?? to.workspaceId
    groups.set(dest, [...(groups.get(dest) ?? []), to])
  }
  return groups
}

async function ensureTabReach(
  deps: PaneMoveToDeps,
  ctx: ControlMethodContext,
  members: string[],
  moving: ReadonlySet<string>,
  tab: string,
): Promise<void> {
  for (const member of members) {
    if (moving.has(member)) continue
    const to = getByPaneId(member)
    if (!to) throw fail(`unknown-pane: ${member}`)
    await ensurePaneReach(deps, 'move', to, ctx, {
      ref: to.externalId,
      method: 'pane.moveTo',
      detail: `join split tab ${tab}, which holds ${to.externalId}`,
    })
  }
}

export function registerPaneMoveToMethods(deps: PaneMoveToDeps): void {
  registerControlMethod('pane.moveTo', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const refs = paneRefs(p.panes)
      const workspace = workspaceOf(p.workspace)
      const tab = tabOf(p.tab)
      if (workspace === undefined && tab === undefined) throw fail('bad-request: workspace or tab')
      if (workspace !== undefined) {
        if (!deps.ownerWindow(workspace)) throw fail(`unknown-workspace: ${workspace}`)
        await deps.ensureReach(
          ctx,
          workspace,
          'pane.moveTo',
          `move panes into workspace ${workspace}`,
        )
      }
      const panes: PaneIdentity[] = []
      for (const ref of refs) {
        const to = await paneTarget(deps, ref, ctx)
        await ensurePaneReach(deps, 'move', to, ctx, {
          ref,
          method: 'pane.moveTo',
          detail: `move ${to.externalId}${workspace ? ` to workspace ${workspace}` : ''}${tab ? ` into split tab ${tab}` : ''}`,
        })
        if (workspace !== undefined && to.workspaceId !== workspace) {
          const check = checkPaneMove(deps, to.windowId, to.workspaceId, workspace, [to.paneId])
          if (!check.ok) throw fail(REFUSALS[check.error])
        }
        panes.push(to)
      }
      const groups = byWorkspace(panes, workspace)
      const moving = new Set(panes.map((to) => to.paneId))
      for (const [dest, group] of groups) {
        const planned = await deps.tabPlan(
          dest,
          group.map((to) => to.paneId),
          tab ?? null,
        )
        if (!planned.ok) throw fail(planned.error.message)
        const plan = planned.result as PaneTabPlan
        if (plan.locked.length > 0) {
          throw fail('pane-locked: the human locked this pane; only they can unlock it')
        }
        if (tab) await ensureTabReach(deps, ctx, plan.members, moving, tab)
      }
      const moved = new Set<string>()
      for (const to of panes) {
        if (workspace === undefined || to.workspaceId === workspace) continue
        const res = await deps.move(to, workspace)
        if (!res.ok) throw fail(res.error.message)
        moved.add(to.externalId)
      }
      if (tab !== undefined) {
        for (const [dest, group] of groups) {
          const res = await deps.joinTab(
            dest,
            group.map((to) => to.paneId),
            tab,
          )
          if (!res.ok) throw fail(res.error.message)
          const joined = (res.result as { moved: string[] }).moved
          for (const to of group) if (joined.includes(to.paneId)) moved.add(to.externalId)
        }
      }
      return {
        ok: true,
        moved: panes.map((to) => to.externalId).filter((id) => moved.has(id)),
        ...(workspace ? { workspaceId: workspace } : {}),
      }
    },
  })
}
