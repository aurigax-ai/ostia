import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from './args'

export interface WorkspaceRow {
  workspaceId: string
  name: string
  customName?: string
}

function shownName(row: WorkspaceRow): string {
  return row.customName || row.name
}

function describeRow(row: WorkspaceRow): string {
  const shown = shownName(row)
  return shown === row.name
    ? `${row.workspaceId} (${shown})`
    : `${row.workspaceId} (${shown}, folder ${row.name})`
}

export function pickWorkspace(rows: readonly WorkspaceRow[], ref: string): string {
  const byId = rows.find((row) => row.workspaceId === ref)
  if (byId) return byId.workspaceId
  const shown = rows.filter((row) => shownName(row) === ref)
  const named = shown.length > 0 ? shown : rows.filter((row) => row.name === ref)
  if (named.length === 1) return named[0].workspaceId
  if (named.length > 1) {
    const candidates = named.map(describeRow).join(', ')
    throw new Error(
      `workspace name '${ref}' matches ${named.length} workspaces: ${candidates}; pass the id`,
    )
  }
  throw new Error(`no workspace '${ref}' (see: ostia workspace list)`)
}

export async function resolveWorkspaceRef(conn: MessageConnection, ref: string): Promise<string> {
  const rows = await conn.sendRequest<WorkspaceRow[]>('workspace.list')
  return pickWorkspace(rows, ref)
}

interface CommandFlags {
  workspace?: string
  rest: string[]
}

export function parseCommandFlags(argv: readonly string[]): CommandFlags {
  const { positional, values } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    unknown: 'keep',
  })
  if (values.workspace === '') throw new FlagError('missing-value', '--workspace')
  return {
    ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
    rest: positional,
  }
}

interface CommandCall {
  id: string
  args?: unknown
  target?: { workspaceId: string; paneId: null }
}

export function buildCommandCall(
  id: string,
  flags: CommandFlags,
  resolvedWorkspace: string | undefined,
): CommandCall {
  const raw = flags.rest[0]
  const args: unknown = raw ? JSON.parse(raw) : undefined
  return {
    id,
    ...(args !== undefined ? { args } : {}),
    ...(resolvedWorkspace ? { target: { workspaceId: resolvedWorkspace, paneId: null } } : {}),
  }
}
