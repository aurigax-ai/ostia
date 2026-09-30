import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'

export type ManagerCall =
  | { method: 'manager.read'; params: { paneId: string; lines?: number } }
  | {
      method: 'manager.spawn'
      params: { agent: string; args: string[]; cwd?: string; workspaceId?: string; name?: string }
    }
  | { method: 'manager.input'; params: { paneId: string; text?: string; keys?: string[] } }

const USAGE = [
  'usage: pine manager read <paneId> [--lines N]',
  '       pine manager spawn <preset> [--cwd DIR] [--workspace ID] [--name NAME] [-- args…]',
  '       pine manager input <paneId> [--text TEXT] [--key KEY]…',
].join('\n')

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1]
  if (value === undefined) throw new Error(`${flag} needs a value`)
  return value
}

export function parseManagerArgs(argv: string[], cwd: string): ManagerCall {
  const [sub, first, ...rest] = argv
  if (!sub || !first) throw new Error(USAGE)
  if (sub === 'read') {
    const params: { paneId: string; lines?: number } = { paneId: first }
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== '--lines') throw new Error(USAGE)
      const lines = Number(takeValue(rest, i, '--lines'))
      if (!Number.isInteger(lines) || lines < 1)
        throw new Error('--lines must be a positive integer')
      params.lines = lines
      i++
    }
    return { method: 'manager.read', params }
  }
  if (sub === 'spawn') {
    const params: {
      agent: string
      args: string[]
      cwd?: string
      workspaceId?: string
      name?: string
    } = { agent: first, args: [] }
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      if (arg === '--') {
        params.args = rest.slice(i + 1)
        break
      }
      if (arg === '--cwd') params.cwd = resolvePath(cwd, takeValue(rest, i, arg))
      else if (arg === '--workspace') params.workspaceId = takeValue(rest, i, arg)
      else if (arg === '--name') params.name = takeValue(rest, i, arg)
      else throw new Error(USAGE)
      i++
    }
    return { method: 'manager.spawn', params }
  }
  if (sub === 'input') {
    const params: { paneId: string; text?: string; keys?: string[] } = { paneId: first }
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      if (arg === '--text') params.text = (params.text ?? '') + takeValue(rest, i, arg)
      else if (arg === '--key') params.keys = [...(params.keys ?? []), takeValue(rest, i, arg)]
      else throw new Error(USAGE)
      i++
    }
    return { method: 'manager.input', params }
  }
  throw new Error(USAGE)
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
    console.error(`pine manager: ${err instanceof Error ? err.message : String(err)}`)
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
