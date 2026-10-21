import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  isScriptTokenPreset,
  NEVER_EXPIRES,
  SCRIPT_CAPABILITIES,
  SCRIPT_TOKEN_PRESETS,
  type ScriptTokenCall,
  type ScriptTokenScope,
  type ScriptTokenUsage,
} from '../../shared/permissions/scriptTokens'
import { parseArgs } from '../common/args'
import { usageOf } from '../common/usageTable'

type ScopeParam =
  | { kind: 'all' }
  | { kind: 'limited'; groups: string[]; workspaces: string[]; ownWorkspaces: boolean }

interface TokenSettings {
  caps?: string[]
  scope?: ScopeParam
  expires?: string
  confirmNeverExpires?: true
}

type TokenCall =
  | { method: 'token.create'; params: { name: string; caps: string[] } & TokenSettings }
  | { method: 'token.update'; params: { id: string; name?: string } & TokenSettings }
  | { method: 'token.list'; params: Record<string, never>; json: boolean }
  | { method: 'token.usage'; params: { id: string }; json: boolean }
  | { method: 'token.revoke'; params: { id: string } }

const TOKEN_USAGE = `${usageOf('token')}\ncapabilities: ${SCRIPT_CAPABILITIES.join(' ')}`

function scopeOf(refs: string[], ownWorkspaces: boolean): ScopeParam | undefined {
  if (refs.length === 0) {
    if (ownWorkspaces) throw new Error('--own-workspaces needs a --scope group:<name|id>')
    return undefined
  }
  if (refs.includes('all')) {
    if (refs.length > 1 || ownWorkspaces) throw new Error('--scope all stands alone')
    return { kind: 'all' }
  }
  const groups: string[] = []
  const workspaces: string[] = []
  for (const ref of refs) {
    const [kind, ...rest] = ref.split(':')
    const value = rest.join(':')
    if (!value || (kind !== 'group' && kind !== 'workspace')) {
      throw new Error(`--scope ${ref} (use all, group:<name|id> or workspace:<name|id>)`)
    }
    ;(kind === 'group' ? groups : workspaces).push(value)
  }
  return { kind: 'limited', groups, workspaces, ownWorkspaces }
}

function capsOf(caps: string[], preset: string | undefined): string[] | undefined {
  if (preset === undefined) return caps.length > 0 ? caps : undefined
  if (!isScriptTokenPreset(preset)) throw new Error(`--preset ${preset} (readonly or coordinator)`)
  return [...new Set([...SCRIPT_TOKEN_PRESETS[preset], ...caps])]
}

function settingsOf(rest: string[], create: boolean) {
  const { positional, values, lists, booleans } = parseArgs(rest, {
    values: { preset: '--preset', expires: '--expires', name: '--name' },
    lists: { caps: '--cap', scopes: '--scope' },
    booleans: { own: '--own-workspaces', never: '--yes-never-expires' },
  })
  const settings: TokenSettings = {}
  const caps = capsOf(lists.caps, values.preset)
  if (caps) settings.caps = caps
  const scope = scopeOf(lists.scopes, booleans.own)
  if (scope) settings.scope = scope
  if (values.expires === NEVER_EXPIRES && !booleans.never) {
    throw new Error(
      '--expires never keeps the token valid until you revoke it; add --yes-never-expires to confirm',
    )
  }
  if (values.expires !== undefined) settings.expires = values.expires
  if (booleans.never) settings.confirmNeverExpires = true
  if (create && values.name !== undefined) throw new Error(TOKEN_USAGE)
  return { positional, settings, name: values.name }
}

export function parseTokenArgs(argv: string[]): TokenCall {
  const [sub, ...rest] = argv
  if (sub === 'create') {
    const { positional, settings } = settingsOf(rest, true)
    const name = positional.join(' ').trim()
    if (!name || !settings.caps) throw new Error(TOKEN_USAGE)
    return { method: 'token.create', params: { name, ...settings, caps: settings.caps } }
  }
  if (sub === 'update') {
    const { positional, settings, name } = settingsOf(rest, false)
    if (positional.length !== 1 || !positional[0]) throw new Error(TOKEN_USAGE)
    const changes = Object.keys(settings).filter((key) => key !== 'confirmNeverExpires')
    if (name === undefined && changes.length === 0) throw new Error(TOKEN_USAGE)
    return {
      method: 'token.update',
      params: { id: positional[0], ...(name !== undefined ? { name } : {}), ...settings },
    }
  }
  if (sub === 'list' || sub === 'show') {
    const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
    if (sub === 'list') {
      if (positional.length > 0) throw new Error(TOKEN_USAGE)
      return { method: 'token.list', params: {}, json: booleans.json }
    }
    if (positional.length !== 1 || !positional[0]) throw new Error(TOKEN_USAGE)
    return { method: 'token.usage', params: { id: positional[0] }, json: booleans.json }
  }
  if (sub === 'revoke') {
    if (rest.length !== 1 || !rest[0]) throw new Error(TOKEN_USAGE)
    return { method: 'token.revoke', params: { id: rest[0] } }
  }
  throw new Error(TOKEN_USAGE)
}

interface ListedToken {
  id: string
  name: string
  caps: string[]
  scope: ScriptTokenScope
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
}

function scopeText(scope: ScriptTokenScope): string {
  if (scope.kind === 'all') return 'all'
  return [
    ...scope.groups.map((id) => `group:${id}`),
    ...scope.workspaces.map((id) => `workspace:${id}`),
    ...(scope.ownWorkspaces ? ['own-workspaces'] : []),
  ].join(',')
}

function settingsText(t: ListedToken): string {
  return `scope ${scopeText(t.scope)}, ${t.expiresAt === null ? 'never expires' : `expires ${t.expiresAt}`}`
}

function targetText(call: ScriptTokenCall, names: ScriptTokenUsage['names']): string {
  const { workspaceId, paneId } = call.target
  const workspace = workspaceId ? (names.workspaces[workspaceId] ?? workspaceId) : ''
  const pane = paneId ? (names.panes[paneId] ?? paneId) : ''
  return [workspace, pane].filter(Boolean).join(' / ') || '-'
}

function resultText(call: ScriptTokenCall): string {
  if (call.outcome === 'ok') return 'ok'
  return call.code ? `${call.outcome} (${call.code})` : call.outcome
}

export function shownUsage(t: ListedToken, usage: ScriptTokenUsage): string[] {
  const pids = usage.connections.flatMap((c) => c.pid ?? [])
  const lines = [
    ...shownToken(t),
    `connected  ${usage.connections.length}${pids.length > 0 ? ` (self-reported pid ${pids.join(', ')})` : ''}`,
    `last ~24h  ${usage.last24h.calls} calls, ${usage.last24h.refused} refused`,
    '',
  ]
  if (usage.calls.length === 0) return [...lines, 'no calls recorded']
  lines.push(['TIME', 'ACTION', 'TARGET', 'RESULT'].join('  '))
  for (const call of usage.calls) {
    lines.push(
      call.outcome === 'regenerated'
        ? `${call.at}  regenerated`
        : [call.at, call.method, targetText(call, usage.names), resultText(call)].join('  '),
    )
  }
  return lines
}

function shownToken(t: ListedToken): string[] {
  return [
    `id         ${t.id}`,
    `name       ${t.name}`,
    `caps       ${t.caps.join(',') || '-'}`,
    `scope      ${scopeText(t.scope)}`,
    `expires    ${t.expiresAt ?? 'never'}`,
    `last used  ${t.lastUsedAt ?? 'never'}`,
    `created    ${t.createdAt}`,
  ]
}

const PRESENCE_NOTICE =
  'ostia token: approve the card in Ostia, then confirm it is you (Touch ID, polkit or an Ostia dialog)'

export function asksPresence(call: TokenCall): boolean {
  if (call.method === 'token.create') return true
  if (call.method !== 'token.update') return false
  const { caps, scope, expires } = call.params
  return caps !== undefined || scope !== undefined || expires !== undefined
}

export async function runTokenVerb(conn: MessageConnection, argv: string[]): Promise<number> {
  let call: TokenCall
  try {
    call = parseTokenArgs(argv)
  } catch (err) {
    console.error(`ostia token: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (call.method === 'token.usage') {
    const shown = await conn.sendRequest<{ token: ListedToken; usage: ScriptTokenUsage }>(
      call.method,
      call.params,
    )
    console.log(
      call.json
        ? JSON.stringify({ ...shown.token, usage: shown.usage })
        : shownUsage(shown.token, shown.usage).join('\n'),
    )
    return 0
  }
  if (call.method === 'token.list') {
    const tokens = await conn.sendRequest<ListedToken[]>(call.method, call.params)
    if (call.json) {
      console.log(JSON.stringify(tokens))
      return 0
    }
    console.log(['ID', 'NAME', 'CAPS', 'SCOPE', 'EXPIRES', 'LAST USED'].join('  '))
    for (const t of tokens) {
      console.log(
        [
          t.id,
          t.name,
          t.caps.join(',') || '-',
          scopeText(t.scope),
          t.expiresAt ?? 'never',
          t.lastUsedAt ?? 'never',
        ].join('  '),
      )
    }
    return 0
  }
  if (asksPresence(call)) console.error(PRESENCE_NOTICE)
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'token.create' || call.method === 'token.update') {
    const done = result as ListedToken & { token?: string }
    if (done.token) {
      console.log(done.token)
      console.error(
        `ostia token: ${call.method === 'token.create' ? 'created' : 'regenerated'} ${done.id} (${settingsText(done)}). This is the only time the token is shown; scripts outside Ostia set OSTIA_TOKEN to it.${call.method === 'token.update' ? ' The old value no longer works.' : ''}`,
      )
    } else {
      console.error(`ostia token: renamed ${done.id} to "${done.name}"; the token is unchanged.`)
    }
  } else {
    console.log('ok')
  }
  return 0
}
