import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from './args'

export interface PaneInputParams {
  pane: string
  text?: string
  keys?: string[]
  paste?: boolean
  force?: boolean
  confirm?: boolean
}

export type PaneCall =
  | { method: 'pane.input'; params: PaneInputParams; stdin?: true }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }

const USAGE = [
  'usage: ostia pane send <pane> [--enter] [--paste|--raw] [--force] [--confirm]',
  '                        [--] <text…|->',
  '       ostia pane key <pane> <key>…',
  '       ostia pane read <pane> [--lines N] [--json]',
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
      booleans: {
        enter: '--enter',
        paste: '--paste',
        raw: '--raw',
        force: '--force',
        confirm: '--confirm',
      },
      unknown: 'keep',
    })
    const { enter, paste, raw, force, confirm } = booleans
    if ((words.length === 0 && !enter) || (paste && raw)) throw new Error(USAGE)
    const stdin = words.length === 1 && words[0] === '-'
    return {
      method: 'pane.input',
      params: {
        pane,
        ...(words.length > 0 && !stdin ? { text: words.join(' ') } : {}),
        ...(enter ? { keys: ['enter'] } : {}),
        ...(paste || raw ? { paste } : {}),
        ...(force ? { force: true } : {}),
        ...(confirm ? { confirm: true } : {}),
      },
      ...(stdin ? { stdin: true as const } : {}),
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

export async function runPaneVerb(
  conn: MessageConnection,
  argv: string[],
  readStdin: () => Promise<string>,
): Promise<number> {
  let call: PaneCall
  try {
    call = parsePaneArgs(argv)
  } catch (err) {
    console.error(`ostia pane: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (call.method === 'pane.input' && call.stdin) {
    const text = await readStdin()
    if (!text) {
      console.error('ostia pane send: nothing on stdin')
      return 1
    }
    call = { method: 'pane.input', params: { ...call.params, text } }
  }
  const result = await conn.sendRequest<unknown>(call.method, call.params)
  if (call.method === 'pane.read' && !call.json) {
    console.log((result as { text: string }).text)
  } else if (call.method === 'pane.read') {
    console.log(JSON.stringify(result, null, 2))
  } else if (call.method === 'pane.input' && call.params.confirm) {
    const responded = (result as { responded?: boolean }).responded === true
    console.log(responded ? 'ok' : 'sent, but the pane printed nothing back')
    return responded ? 0 : 2
  } else {
    console.log('ok')
  }
  return 0
}
