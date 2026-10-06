import type { MessageConnection } from 'vscode-jsonrpc/node'

export interface WorkspaceRow {
  workspaceId: string
  name: string
}

export function pickWorkspace(rows: readonly WorkspaceRow[], ref: string): string {
  const byId = rows.find((row) => row.workspaceId === ref)
  if (byId) return byId.workspaceId
  const named = rows.filter((row) => row.name === ref)
  if (named.length === 1) return named[0].workspaceId
  if (named.length > 1) {
    const ids = named.map((row) => row.workspaceId).join(', ')
    throw new Error(`workspace name '${ref}' is ambiguous (${ids}); pass the id`)
  }
  throw new Error(`no workspace '${ref}' (see: ostia workspace list)`)
}

export async function resolveWorkspaceRef(conn: MessageConnection, ref: string): Promise<string> {
  const rows = await conn.sendRequest<WorkspaceRow[]>('workspace.list')
  return pickWorkspace(rows, ref)
}

export interface CommandFlags {
  workspace?: string
  noFocus: boolean
  rest: string[]
}

export function parseCommandFlags(argv: readonly string[]): CommandFlags {
  const rest: string[] = []
  let workspace: string | undefined
  let noFocus = false
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--no-focus') {
      noFocus = true
    } else if (word === '--workspace') {
      const value = argv[++i]
      if (!value) throw new Error('--workspace needs a value')
      workspace = value
    } else if (word.startsWith('--workspace=')) {
      workspace = word.slice('--workspace='.length)
      if (!workspace) throw new Error('--workspace needs a value')
    } else {
      rest.push(word)
    }
  }
  return { ...(workspace !== undefined ? { workspace } : {}), noFocus, rest }
}

export interface CommandCall {
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
  let args: unknown = raw ? JSON.parse(raw) : undefined
  if (flags.noFocus) {
    if (id !== 'workspace.new') throw new Error('--no-focus only applies to workspace.new')
    const given = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}
    args = { ...given, focus: false }
  }
  return {
    id,
    ...(args !== undefined ? { args } : {}),
    ...(resolvedWorkspace ? { target: { workspaceId: resolvedWorkspace, paneId: null } } : {}),
  }
}
