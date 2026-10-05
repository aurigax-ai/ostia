import type { MessageConnection } from 'vscode-jsonrpc/node'
import { parseArgs } from './args'

export type TokenCall =
  | { method: 'token.create'; params: { name: string; caps: string[] } }
  | { method: 'token.list'; params: Record<string, never>; json: boolean }
  | { method: 'token.revoke'; params: { id: string } }

export const TOKEN_USAGE = [
  'usage: ostia token create <name> --cap <capability>…',
  '       ostia token list [--json]',
  '       ostia token revoke <id>',
  'capabilities: read-board read-other-pane type-other-pane all-workspaces',
].join('\n')

export function parseTokenArgs(argv: string[]): TokenCall {
  const [sub, ...rest] = argv
  if (sub === 'create') {
    const { positional, lists } = parseArgs(rest, { lists: { caps: '--cap' } })
    const name = positional.join(' ').trim()
    if (!name || lists.caps.length === 0) throw new Error(TOKEN_USAGE)
    return { method: 'token.create', params: { name, caps: lists.caps } }
  }
  if (sub === 'list') {
    const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
    if (positional.length > 0) throw new Error(TOKEN_USAGE)
    return { method: 'token.list', params: {}, json: booleans.json }
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
  createdAt: string
}

export async function runTokenVerb(conn: MessageConnection, argv: string[]): Promise<number> {
  let call: TokenCall
  try {
    call = parseTokenArgs(argv)
  } catch (err) {
    console.error(`ostia token: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'token.create') {
    const created = result as { id: string; token: string }
    console.log(created.token)
    console.error(
      `ostia token: created ${created.id}. This is the only time the token is shown; scripts outside Ostia set OSTIA_TOKEN to it.`,
    )
  } else if (call.method === 'token.list' && call.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (call.method === 'token.list') {
    for (const t of result as ListedToken[]) {
      console.log(`${t.id}  ${t.name}  ${t.caps.join(',')}  ${t.createdAt}`)
    }
  } else {
    console.log('ok')
  }
  return 0
}
