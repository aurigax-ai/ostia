import type { CommandResult } from '../../shared/control/commands'
import type { ControlMethodContext } from '../control/controlServer'
import { getByPaneId, type PaneIdentity } from '../control/idRegistry'
import type { PaneLifecycle } from './paneLifecycle'
import type { PaneEntry } from './paneList'
import { ensurePaneReach, fail, type PaneReachDeps } from './paneReach'

type SkipReason = 'locked' | 'unsaved' | 'not-finished'

interface FinishedSkip {
  paneId: string
  reason: SkipReason
}

export interface CloseFinishedResult {
  ok: true
  closed: string[]
  already: { paneId: string; closedAt: number; name?: string }[]
  skipped: FinishedSkip[]
  reason?: 'no-children'
}

export interface CloseFinishedDeps extends PaneReachDeps {
  panes: () => Promise<PaneEntry[]>
  lifecycle: Pick<PaneLifecycle, 'evaluate'>
  childrenOf: (ownerPaneId: string) => string[]
  closeBlock: (to: PaneIdentity) => Promise<'locked' | 'unsaved' | null>
  close: (to: PaneIdentity) => Promise<CommandResult>
  confirmGone: (to: PaneIdentity) => Promise<{ ok: true } | { ok: false; reason: string }>
}

async function stillFinished(deps: CloseFinishedDeps, to: PaneIdentity): Promise<boolean> {
  const entries = await deps.panes()
  return (await deps.lifecycle.evaluate(entries)).get(to.externalId)?.finished === true
}

export async function closeFinished(
  deps: CloseFinishedDeps,
  ctx: ControlMethodContext,
): Promise<CloseFinishedResult> {
  const me = ctx.identity
  const children = me.kind === 'pane' ? deps.childrenOf(me.paneId) : []
  const identities = children.flatMap((id) => getByPaneId(id) ?? [])
  const result: CloseFinishedResult = { ok: true, closed: [], already: [], skipped: [] }
  if (identities.length === 0) return { ...result, reason: 'no-children' }
  for (const to of identities) {
    await ensurePaneReach(deps, 'close', to, ctx, {
      ref: to.externalId,
      method: 'pane.close',
      detail: `close ${to.externalId}`,
    })
    const block = await deps.closeBlock(to)
    if (block) {
      result.skipped.push({ paneId: to.externalId, reason: block })
      continue
    }
    if (!(await stillFinished(deps, to))) {
      result.skipped.push({ paneId: to.externalId, reason: 'not-finished' })
      continue
    }
    const res = await deps.close(to)
    if (!res.ok) throw fail(res.error.message)
    const gone = await deps.confirmGone(to)
    if (!gone.ok) throw fail(gone.reason)
    result.closed.push(to.externalId)
  }
  return result
}
