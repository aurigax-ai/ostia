import type { CommandResult, PaneMoveError } from '../../shared/types'
import type { Reach } from '../approvals/reach'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { type PaneReachDeps, ensurePaneReach, fail, paneRefs, paneTarget, record } from './paneIo'
import { type PaneMoveDeps, checkPaneMove } from './paneMove'

export interface PaneMoveToDeps extends PaneReachDeps, Omit<PaneMoveDeps, 'movePanes'> {
  ensureReach: Reach['ensure']
  move: (pane: PaneIdentity, workspaceId: string) => Promise<CommandResult>
}

const REFUSALS: Readonly<Record<PaneMoveError, string>> = {
  'not-owned': 'other-window: the pane and the workspace are in different windows',
  manager: 'unknown-pane: no such pane',
  scratch: 'scratch: a pane never moves into or out of a scratch workspace',
  sandbox: 'sandboxed: a pane never moves into or out of a sandboxed workspace',
}

export function registerPaneMoveToMethods(deps: PaneMoveToDeps): void {
  registerControlMethod('pane.moveTo', {
    handler: async (raw, ctx) => {
      const p = record(raw)
      const refs = paneRefs(p.panes)
      if (typeof p.workspace !== 'string' || !p.workspace) throw fail('bad-request: workspace')
      const workspaceId = p.workspace
      if (!deps.ownerWindow(workspaceId)) throw fail(`unknown-workspace: ${workspaceId}`)
      await deps.ensureReach(
        ctx,
        workspaceId,
        'pane.moveTo',
        `move panes into workspace ${workspaceId}`,
      )
      const panes: PaneIdentity[] = []
      for (const ref of refs) {
        const to = await paneTarget(deps, ref, ctx)
        await ensurePaneReach(deps, 'move', to, ctx, {
          ref,
          method: 'pane.moveTo',
          detail: `move ${to.externalId} to workspace ${workspaceId}`,
        })
        if (to.workspaceId === workspaceId) continue
        const check = checkPaneMove(deps, to.windowId, to.workspaceId, workspaceId, [to.paneId])
        if (!check.ok) throw fail(REFUSALS[check.error])
        panes.push(to)
      }
      const moved: string[] = []
      for (const to of panes) {
        const res = await deps.move(to, workspaceId)
        if (!res.ok) throw fail(res.error.message)
        moved.push(to.externalId)
      }
      return { ok: true, moved, workspaceId }
    },
  })
}
