import { ageLabel, SHORT_ID_LENGTH } from '../../shared/panes/paneStatus'

export const PREFIX_MIN = SHORT_ID_LENGTH

export interface ClosedPane {
  externalId: string
  workspaceId: string
  name?: string
  closedAt: number
}

const CLOSED_MAX = 256
const closed = new Map<string, ClosedPane>()

export function rememberClosedPane(pane: ClosedPane): void {
  closed.delete(pane.externalId)
  closed.set(pane.externalId, pane)
  const oldest = closed.keys().next().value
  if (closed.size > CLOSED_MAX && oldest !== undefined) closed.delete(oldest)
}

export function recallClosedPane(
  ref: string,
  visible: (workspaceId: string) => boolean,
): ClosedPane | undefined {
  const exact = closed.get(ref)
  if (exact) return visible(exact.workspaceId) ? exact : undefined
  if (ref.length < PREFIX_MIN) return undefined
  const matches = [...closed.values()].filter(
    (pane) => pane.externalId.startsWith(ref) && visible(pane.workspaceId),
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function forgetClosedPanes(): void {
  closed.clear()
}

export function closedLabel(pane: ClosedPane, now: number): string {
  const name = pane.name ? ` (${pane.name})` : ''
  return `closed ${ageLabel(now - pane.closedAt)} ago${name}`
}
