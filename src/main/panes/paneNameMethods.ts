import { registerControlMethod } from '../control/controlServer'
import { getByPaneId } from '../control/idRegistry'
import { claimName, dropName, parseName } from './paneNames'
import { fail, record } from './paneReach'
import { type PaneRefDeps, paneSight } from './paneRef'

export interface PaneNameDeps {
  visible: PaneRefDeps['visible']
  isSandboxed: PaneRefDeps['isSandboxed']
  isConfined: PaneRefDeps['isConfined']
  processPane: PaneRefDeps['processPane']
  agentRunning: (paneId: string) => boolean
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
      if (!deps.agentRunning(me.paneId)) {
        throw fail('not-an-agent: only a claude or codex agent with its hooks on takes a bus name')
      }
      const wanted = parseName(p.name)
      const wantedName = 'name' in wanted ? wanted.name : undefined
      const tabs = wantedName
        ? (await deps.processPane(wantedName, ctx)).filter((id) => id !== me.paneId)
        : []
      if (tabs.length > 0) {
        const tab = getByPaneId(tabs[0])?.externalId
        throw fail(`name-taken: ${wantedName} is the --name of the tab ${tab}`)
      }
      const sees = await paneSight(deps, ctx)
      const claim = claimName(me.paneId, p.name, p.desc, (holderPaneId) => {
        const holder = getByPaneId(holderPaneId)
        return holder !== undefined && sees(holder)
      })
      if (!claim.ok && claim.error === 'name-taken') {
        const holder = getByPaneId(claim.holder)
        throw fail(`name-taken: ${claim.name} held by ${holder?.externalId ?? 'another pane'}`)
      }
      if (!claim.ok) throw fail(`${claim.error}: ${claim.message}`)
      const { name, desc } = claim.held
      return { ok: true, paneId: me.externalId, name, ...(desc ? { desc } : {}) }
    },
  })
}
