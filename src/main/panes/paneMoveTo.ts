import { actThenConfirm, confirmed, mismatch, pollEvery } from '../../shared/common/actThenConfirm'
import type { CommandResult } from '../../shared/control/commands'
import { normalizeSplitTabName } from '../../shared/workspaces/splitTabs'
import type { PaneMoveError } from '../../shared/workspaces/workspaceApi'
import type { Reach } from '../approvals/reach'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { getByPaneId, type PaneIdentity } from '../control/idRegistry'
import type { PaneEntry } from './paneList'
import { checkPaneMove, type PaneMoveDeps } from './paneMove'
import {
  ensurePaneReach,
  fail,
  type PaneReachDeps,
  paneRefs,
  paneTarget,
  record,
} from './paneReach'

interface PaneTabPlan {
  members: string[]
  locked: string[]
  human?: string | null
}

export interface PaneMoveToDeps extends PaneReachDeps, Omit<PaneMoveDeps, 'movePanes'> {
  ensureReach: Reach['ensure']
  move: (pane: PaneIdentity, workspaceId: string) => Promise<CommandResult>
  tabPlan: (workspaceId: string, paneIds: string[], tab: string | null) => Promise<CommandResult>
  joinTab: (workspaceId: string, paneIds: string[], tab: string | null) => Promise<CommandResult>
  panes: () => Promise<PaneEntry[]>
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

interface Placement {
  paneId: string
  workspaceId: string
  splitTabName?: string
}

const PLACEMENT_CONFIRM_MS = 3000
const PLACEMENT_POLL_MS = 100

function placementProblem(
  entry: PaneEntry | undefined,
  dest: string,
  tab: string | null | undefined,
  untabbed: boolean,
): string | null {
  if (!entry) return 'is gone'
  if (entry.workspaceId !== dest) return `is in workspace ${entry.workspaceId}, not ${dest}`
  if (tab === undefined) return null
  if (tab === null) return entry.splitTabName ? `is still in split tab ${entry.splitTabName}` : null
  if (entry.splitTabName === tab) return null
  if (!entry.splitTabName && untabbed) return null
  return entry.splitTabName
    ? `is in split tab ${entry.splitTabName}, not ${tab}`
    : `is in no split tab, not ${tab}`
}

function confirmPlacement(
  deps: PaneMoveToDeps,
  panes: PaneIdentity[],
  groups: Map<string, PaneIdentity[]>,
  workspace: string | undefined,
  tab: string | null | undefined,
  whole: ReadonlySet<string>,
) {
  let last = 'the layout did not answer'
  return actThenConfirm<Placement[]>({
    act: () => undefined,
    observe: async () => {
      const listed = await deps.panes()
      const placed: Placement[] = []
      for (const to of panes) {
        const entry = listed.find((p) => p.paneId === to.externalId)
        const dest = workspace ?? to.workspaceId
        const untabbed = (groups.get(dest)?.length ?? 0) === 1 || whole.has(dest)
        const problem = placementProblem(entry, dest, tab, untabbed)
        if (problem || !entry) {
          last = `misplaced: ${to.externalId} ${problem ?? 'is gone'}`
          return undefined
        }
        placed.push({
          paneId: entry.paneId,
          workspaceId: entry.workspaceId,
          ...(entry.splitTabName ? { splitTabName: entry.splitTabName } : {}),
        })
      }
      return confirmed(placed)
    },
    signal: pollEvery(PLACEMENT_POLL_MS),
    timeoutMs: PLACEMENT_CONFIRM_MS,
    onTimeout: () => mismatch(last),
  })
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
        if (typeof plan.human === 'string') {
          throw fail(
            `human-tab: split tab ${plan.human || '(unnamed)'} is the human's; agents join only split tabs an agent made`,
          )
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
      const whole = new Set<string>()
      if (tab !== undefined) {
        for (const [dest, group] of groups) {
          const res = await deps.joinTab(
            dest,
            group.map((to) => to.paneId),
            tab,
          )
          if (!res.ok) throw fail(res.error.message)
          const joined = res.result as { moved: string[]; whole?: boolean }
          if (joined.whole) whole.add(dest)
          for (const to of group) if (joined.moved.includes(to.paneId)) moved.add(to.externalId)
        }
      }
      const placement = await confirmPlacement(deps, panes, groups, workspace, tab, whole)
      if (!placement.ok) throw fail(placement.reason)
      return {
        ok: true,
        placement: placement.value,
        moved: panes.map((to) => to.externalId).filter((id) => moved.has(id)),
        ...(workspace ? { workspaceId: workspace } : {}),
      }
    },
  })
}
