import { type PaneIdentity, resolveExternal } from './idRegistry'

export const SCRIPT_COMMANDS: ReadonlySet<string> = new Set(['workspace.new', 'pane.close'])

export type PaneArgs =
  | { ok: true; args: unknown; pane: PaneIdentity | null }
  | { ok: false; error: string }

export function internalPaneArgs(args: unknown): PaneArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: true, args, pane: null }
  }
  const given = (args as Record<string, unknown>).paneId
  if (typeof given !== 'string') return { ok: true, args, pane: null }
  const pane = resolveExternal(given)
  if (!pane || pane.kind !== 'pane') {
    return { ok: false, error: `unknown-pane: ${given} (use a paneId from ostia pane list)` }
  }
  return { ok: true, args: { ...args, paneId: pane.paneId }, pane }
}

export function externalPaneMessage(message: string, pane: PaneIdentity | null): string {
  return pane ? message.replaceAll(pane.paneId, pane.externalId) : message
}
