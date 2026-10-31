import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { type PaneIdentity, resolveExternal } from './idRegistry'

export const SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  'workspace.new',
  'pane.close',
  'workspace.close',
  'workspace.group',
  'workspace.groupColor',
  'workspace.groupRename',
  'workspace.groupDelete',
  'workspace.pin',
  'workspace.unpin',
  'workspace.ungroup',
  'workspace.newScratch',
])

export type PaneArgs =
  | { ok: true; args: unknown; pane: PaneIdentity | null }
  | { ok: false; error: string }

export function internalPaneArgs(args: unknown): PaneArgs {
  if (!isRecord(args)) return { ok: true, args, pane: null }
  const given = args.paneId
  if (typeof given !== 'string') return { ok: true, args, pane: null }
  const pane = resolveExternal(given)
  if (pane?.kind !== 'pane') {
    return { ok: false, error: `unknown-pane: ${given} (use a paneId from ostia pane list)` }
  }
  return { ok: true, args: { ...args, paneId: pane.paneId }, pane }
}

export function externalPaneMessage(message: string, pane: PaneIdentity | null): string {
  return pane ? message.replaceAll(pane.paneId, pane.externalId) : message
}
