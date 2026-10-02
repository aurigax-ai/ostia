import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from './args'

export type PaneCall =
  | { method: 'pane.input'; params: { pane: string; text?: string; keys?: string[] } }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }

const USAGE = [
  'usage: pine pane send <pane> [--enter] [--] <text…>',
  '       pine pane key <pane> <key>…',
  '       pine pane read <pane> [--lines N] [--json]',
  '<pane> is a pane id from pine pane.list, or a process id or name from pine process ls',
].join('\n')

function readFlags(argv: string[]) {
  try {
    return parseArgs(argv, { values: { lines: '--lines' }, booleans: { json: '--json' } })
  } catch (err) {
    if (err instanceof FlagError && err.problem === 'unknown') throw new Error(USAGE)
    throw err
  }
}

export function parsePaneArgs(argv: string[]): PaneCall {
  const [sub, pane, ...rest] = argv
  if (!sub || !pane) throw new Error(USAGE)
  if (sub === 'send') {
    const { positional: words, booleans } = parseArgs(rest, {
      booleans: { enter: '--enter' },
      unknown: 'keep',
    })
    const { enter } = booleans
    if (words.length === 0 && !enter) throw new Error(USAGE)
    return {
      method: 'pane.input',
      params: {
        pane,
        ...(words.length > 0 ? { text: words.join(' ') } : {}),
        ...(enter ? { keys: ['enter'] } : {}),
      },
    }
  }
  if (sub === 'key') {
    if (rest.length === 0) throw new Error(USAGE)
    return { method: 'pane.input', params: { pane, keys: rest } }
  }
  if (sub === 'read') {
    const { positional, values, booleans } = readFlags(rest)
    if (positional.length > 0) throw new Error(USAGE)
    if (values.lines === undefined) {
      return { method: 'pane.read', params: { pane }, json: booleans.json }
    }
    const lines = Number(values.lines)
    if (!Number.isInteger(lines) || lines < 1) {
      throw new Error('--lines must be a positive integer')
    }
    return { method: 'pane.read', params: { pane, lines }, json: booleans.json }
  }
  throw new Error(USAGE)
}

export async function runPaneVerb(conn: MessageConnection, argv: string[]): Promise<number> {
  let call: PaneCall
  try {
    call = parsePaneArgs(argv)
  } catch (err) {
    console.error(`pine pane: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'pane.read' && !call.json) {
    console.log((result as { text: string }).text)
  } else if (call.method === 'pane.read') {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('ok')
  }
  return 0
}
