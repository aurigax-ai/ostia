import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from './args'

export type ManagerCall =
  | { method: 'manager.read'; params: { paneId: string; lines?: number } }
  | {
      method: 'manager.spawn'
      params: { agent: string; args: string[]; cwd?: string; workspaceId?: string; name?: string }
    }
  | { method: 'manager.input'; params: { paneId: string; text?: string; keys?: string[] } }

const USAGE = [
  'usage: ostia manager read <paneId> [--lines N]',
  '       ostia manager spawn <preset> [--cwd DIR] [--workspace ID] [--name NAME] [-- args…]',
  '       ostia manager input <paneId> [--text TEXT] [--key KEY]…',
].join('\n')

function managerCall(argv: string[], cwd: string): ManagerCall {
  const [sub, first, ...rest] = argv
  if (!sub || !first) throw new Error(USAGE)
  if (sub === 'read') {
    const { positional, values } = parseArgs(rest, { values: { lines: '--lines' } })
    if (positional.length > 0) throw new Error(USAGE)
    if (values.lines === undefined) return { method: 'manager.read', params: { paneId: first } }
    const lines = Number(values.lines)
    if (!Number.isInteger(lines) || lines < 1) throw new Error('--lines must be a positive integer')
    return { method: 'manager.read', params: { paneId: first, lines } }
  }
  if (sub === 'spawn') {
    const { positional, values } = parseArgs(rest, {
      values: { cwd: '--cwd', workspace: '--workspace', name: '--name' },
    })
    return {
      method: 'manager.spawn',
      params: {
        agent: first,
        args: positional,
        ...(values.cwd === undefined ? {} : { cwd: resolvePath(cwd, values.cwd) }),
        ...(values.workspace === undefined ? {} : { workspaceId: values.workspace }),
        ...(values.name === undefined ? {} : { name: values.name }),
      },
    }
  }
  if (sub === 'input') {
    const { positional, lists } = parseArgs(rest, { lists: { text: '--text', key: '--key' } })
    if (positional.length > 0) throw new Error(USAGE)
    return {
      method: 'manager.input',
      params: {
        paneId: first,
        ...(lists.text.length > 0 ? { text: lists.text.join('') } : {}),
        ...(lists.key.length > 0 ? { keys: lists.key } : {}),
      },
    }
  }
  throw new Error(USAGE)
}

export function parseManagerArgs(argv: string[], cwd: string): ManagerCall {
  try {
    return managerCall(argv, cwd)
  } catch (err) {
    if (err instanceof FlagError && err.problem === 'unknown') throw new Error(USAGE)
    throw err
  }
}

export async function runManagerVerb(
  conn: MessageConnection,
  argv: string[],
  cwd: string,
): Promise<number> {
  let call: ManagerCall
  try {
    call = parseManagerArgs(argv, cwd)
  } catch (err) {
    console.error(`ostia manager: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'manager.read') {
    console.log((result as { text: string }).text)
  } else {
    console.log(JSON.stringify(result))
  }
  return 0
}
