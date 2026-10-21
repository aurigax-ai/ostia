import type { Reach } from '../approvals/reach'
import { registerControlMethod } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import { claimName, dropName } from './paneNames'
import { fail, record } from './paneReach'
import type { PaneRefDeps } from './paneRef'

export interface PaneNameDeps {
  reach: Pick<Reach, 'visible'>
  isSandboxed: PaneRefDeps['isSandboxed']
  isConfined: PaneRefDeps['isConfined']
}

export function registerPaneNameMethods(deps: PaneNameDeps): void {
  registerControlMethod('pane.name', {
    cap: 'drive-self',
    handler: async (raw, ctx) => {
      const p = record(raw)
      const me = ctx.identity
      if (me.manager) throw fail('not-available: the manager pane takes no bus name')
      if (p.clear === true) {
        if (p.name !== undefined || p.desc !== undefined) throw fail('bad-request: clear')
        dropName(me.paneId)
        return { ok: true, paneId: me.externalId }
      }
      const claim = claimName(me.paneId, p.name, p.desc)
      if (!claim.ok && claim.error === 'name-taken') {
        const holder = getByPaneId(claim.holder)
        const sandboxed = deps.isSandboxed(me.workspaceId)
        const reaches = sandboxed ? () => false : await deps.reach.visible(ctx)
        const sees =
          holder !== undefined &&
          (holder.workspaceId === me.workspaceId || reaches(holder.workspaceId)) &&
          (!sandboxed || (holder.workspaceId === me.workspaceId && deps.isConfined(holder.paneId)))
        const by = sees ? holder.externalId : 'another pane'
        throw fail(`name-taken: ${claim.name} held by ${by}`)
      }
      if (!claim.ok) throw fail(`${claim.error}: ${claim.message}`)
      const { name, desc } = claim.held
      return { ok: true, paneId: me.externalId, name, ...(desc ? { desc } : {}) }
    },
  })
}
