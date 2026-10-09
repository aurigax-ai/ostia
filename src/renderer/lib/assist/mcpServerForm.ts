import {
  MCP_ENV_KEY,
  MCP_ENV_MAX,
  MCP_SECRETS_MAX,
  MCP_SERVER_NAME,
  type McpServerSettings,
  type McpTransportKind,
  isMcpArgv,
  isMcpSecretKey,
  isMcpUrl,
  mcpTransportOf,
} from '@shared/assist/chatTools'
import { isDangerousSegment } from '@shared/protoGuard'
import { splitArgs } from '@shared/terminal/argv'
import { quoteArgv } from '@shared/terminal/shellQuote'

export interface KeyValueRow {
  id: number
  key: string
  value: string
}

let rowSeq = 0

export function newRow(): KeyValueRow {
  rowSeq += 1
  return { id: rowSeq, key: '', value: '' }
}

export interface SecretDraft extends KeyValueRow {
  saved: boolean
}

export interface McpServerDraft {
  name: string
  transport: McpTransportKind
  command: string
  args: string
  url: string
  env: KeyValueRow[]
  secrets: SecretDraft[]
}

export type McpDraftField = 'name' | 'command' | 'args' | 'url' | 'env' | 'secrets'

export type McpDraftResult =
  | {
      ok: true
      server: McpServerSettings
      secretValues: Record<string, string>
      removedSecrets: string[]
    }
  | { ok: false; errors: McpDraftField[] }

export function draftFromServer(server: McpServerSettings | null): McpServerDraft {
  const argv = server?.command ?? []
  return {
    name: server?.name ?? '',
    transport: server ? mcpTransportOf(server) : 'stdio',
    command: argv[0] ?? '',
    args: quoteArgv(argv.slice(1)),
    url: server?.url ?? '',
    env: Object.entries(server?.env ?? {}).map(([key, value]) => ({ ...newRow(), key, value })),
    secrets: (server?.secrets ?? []).map((key) => ({ ...newRow(), key, saved: true })),
  }
}

const isBlank = (row: KeyValueRow): boolean => !row.key.trim() && !row.value

function parseEnv(rows: KeyValueRow[]): Record<string, string> | null {
  const env: Record<string, string> = {}
  for (const row of rows) {
    if (isBlank(row)) continue
    const key = row.key.trim()
    if (!MCP_ENV_KEY.test(key) || isDangerousSegment(key) || key in env) return null
    env[key] = row.value
  }
  return Object.keys(env).length > MCP_ENV_MAX ? null : env
}

function secretsValid(transport: McpTransportKind, rows: SecretDraft[]): boolean {
  const seen = new Set<string>()
  for (const row of rows) {
    if (isBlank(row) && !row.saved) continue
    const key = row.key.trim()
    if (!isMcpSecretKey(transport, key) || seen.has(key)) return false
    if (!row.saved && !row.value) return false
    seen.add(key)
  }
  return seen.size <= MCP_SECRETS_MAX
}

export function serverFromDraft(
  draft: McpServerDraft,
  original: McpServerSettings | null,
  takenNames: readonly string[],
): McpDraftResult {
  const errors: McpDraftField[] = []
  const name = original ? original.name : draft.name.trim()
  if (!original && (!MCP_SERVER_NAME.test(name) || takenNames.includes(name))) errors.push('name')
  let target: Pick<McpServerSettings, 'command' | 'url'> = {}
  let env: Record<string, string> = {}
  if (draft.transport === 'http') {
    const url = draft.url.trim()
    if (isMcpUrl(url)) target = { url }
    else errors.push('url')
  } else {
    const command = draft.command.trim()
    const args = splitArgs(draft.args.trim())
    if (!command) errors.push('command')
    if (args === null) errors.push('args')
    const argv = [command, ...(args ?? [])]
    if (command && args !== null) {
      if (isMcpArgv(argv)) target = { command: argv }
      else errors.push('args')
    }
    const parsed = parseEnv(draft.env)
    if (parsed) env = parsed
    else errors.push('env')
  }
  if (!secretsValid(draft.transport, draft.secrets)) errors.push('secrets')
  if (errors.length > 0) return { ok: false, errors }
  const kept = draft.secrets.filter((row) => row.saved || !isBlank(row))
  const secrets = kept.map((row) => row.key.trim())
  const secretValues: Record<string, string> = {}
  for (const row of kept) if (row.value) secretValues[row.key.trim()] = row.value
  const server: McpServerSettings = {
    name,
    enabled: original?.enabled ?? true,
    env,
    secrets,
    disabledTools: original?.disabledTools ?? [],
    ...target,
  }
  const removedSecrets = (original?.secrets ?? []).filter((key) => !secrets.includes(key))
  return { ok: true, server, secretValues, removedSecrets }
}

export function skillsInFolder<T extends { path: string }>(
  skills: readonly T[],
  folder: string,
): T[] {
  const prefix = `${folder.replace(/\/+$/, '')}/`
  return skills.filter((s) => s.path === folder || s.path.startsWith(prefix))
}
