import type { ControlMethodContext } from '../control/controlServer'
import {
  type PaneIdentity,
  getByPaneId,
  paneIdentities,
  resolveExternal,
} from '../control/idRegistry'
import { type ClosedPane, PREFIX_MIN, closedLabel, recallClosedPane } from './closedPanes'

const ID_PREFIX = /^[0-9a-f-]+$/

export interface PaneRefDeps {
  processPane: (ref: string, ctx: ControlMethodContext) => Promise<string[]>
  visible: (ctx: ControlMethodContext) => Promise<(workspaceId: string) => boolean>
}

export type PaneRef =
  | { found: PaneIdentity }
  | { closed: ClosedPane }
  | { ambiguous: PaneIdentity[] }
  | { unknown: true }

function asPane(paneId: string): PaneIdentity | undefined {
  const found = getByPaneId(paneId)
  return found?.kind === 'pane' ? found : undefined
}

export async function resolvePaneRef(
  deps: PaneRefDeps,
  ref: string,
  ctx: ControlMethodContext,
  destructive: boolean,
): Promise<PaneRef> {
  const exact = resolveExternal(ref)
  if (exact?.kind === 'pane') return { found: exact }
  const named = (await deps.processPane(ref, ctx)).flatMap((id) => asPane(id) ?? [])
  if (named.length > 0) {
    return destructive && named.length > 1 ? { ambiguous: named } : { found: named[0] }
  }
  const reaches = await deps.visible(ctx)
  const mine = (workspaceId: string): boolean =>
    workspaceId === ctx.identity.workspaceId || reaches(workspaceId)
  const prefix = ref.toLowerCase()
  if (prefix.length >= PREFIX_MIN && ID_PREFIX.test(prefix)) {
    const matches = paneIdentities().filter(
      (pane) =>
        pane.kind === 'pane' &&
        !pane.manager &&
        pane.externalId.startsWith(prefix) &&
        mine(pane.workspaceId),
    )
    if (matches.length === 1) return { found: matches[0] }
    if (matches.length > 1) return { ambiguous: matches }
    const closed = recallClosedPane(prefix, mine)
    if (closed) return { closed }
  }
  const closed = recallClosedPane(ref, mine)
  return closed ? { closed } : { unknown: true }
}

export interface RefProblem {
  error: 'unknown-pane' | 'ambiguous-pane'
  message: string
}

export function refProblem(
  ref: string,
  result: Exclude<PaneRef, { found: PaneIdentity }>,
): RefProblem {
  if ('closed' in result) {
    return {
      error: 'unknown-pane',
      message: `${ref} ${closedLabel(result.closed, Date.now())}. List the panes still open with ostia pane list`,
    }
  }
  if ('ambiguous' in result) {
    const list = result.ambiguous
      .map((pane) => `${pane.externalId} (${pane.workspaceId})`)
      .join(', ')
    return { error: 'ambiguous-pane', message: `${ref} matches ${list}; pass one of those ids` }
  }
  return {
    error: 'unknown-pane',
    message: `${ref}. List the panes you can reach with ostia pane list`,
  }
}

export function refFailure(ref: string, result: Exclude<PaneRef, { found: PaneIdentity }>): string {
  const { error, message } = refProblem(ref, result)
  return `${error}: ${message}`
}
