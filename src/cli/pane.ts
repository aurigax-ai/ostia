import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from './args'

export type PaneCall =
  | { method: 'pane.input'; params: { pane: string; text?: string; keys?: string[] } }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }
  | { method: 'pane.rename'; params: { pane: string; title: string } }

const USAGE = [
  'usage: ostia pane send <pane> [--enter] [--] <text…>',
  '       ostia pane key <pane> <key>…',
  '       ostia pane read <pane> [--lines N] [--json]',
  '       ostia pane rename <pane> <title…> | --clear',
  '<pane> is a pane id from ostia pane.list, or a process id or name from ostia process ls',
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
  if (sub === 'rename') {
    const { positional, booleans } = parseArgs(rest, {
      booleans: { clear: '--clear' },
      unknown: 'keep',
    })
    const title = positional.join(' ').trim()
    if (booleans.clear === Boolean(title)) throw new Error(USAGE)
    return { method: 'pane.rename', params: { pane, title } }
  }
  throw new Error(USAGE)
}

export function parseWorkspaceRenameArgs(argv: string[]): { workspace?: string; name: string } {
  const { positional, values, booleans } = parseArgs(argv, {
    values: { workspace: '--workspace' },
    booleans: { clear: '--clear' },
    unknown: 'keep',
  })
  const name = positional.join(' ').trim()
  if (booleans.clear === Boolean(name)) {
    throw new Error('usage: ostia workspace rename [--workspace <id>] <name…> | --clear')
  }
  return { ...(values.workspace ? { workspace: values.workspace } : {}), name }
}

export async function runPaneVerb(conn: MessageConnection, argv: string[]): Promise<number> {
  let call: PaneCall
  try {
    call = parsePaneArgs(argv)
  } catch (err) {
    console.error(`ostia pane: ${err instanceof Error ? err.message : String(err)}`)
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
