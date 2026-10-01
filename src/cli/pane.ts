import type { MessageConnection } from 'vscode-jsonrpc/node'

export type PaneCall =
  | { method: 'pane.input'; params: { pane: string; text?: string; keys?: string[] } }
  | { method: 'pane.read'; params: { pane: string; lines?: number }; json: boolean }

const USAGE = [
  'usage: pine pane send <pane> [--enter] [--] <text…>',
  '       pine pane key <pane> <key>…',
  '       pine pane read <pane> [--lines N] [--json]',
  '<pane> is a pane id from pine pane.list, or a process id or name from pine process ls',
].join('\n')

export function parsePaneArgs(argv: string[]): PaneCall {
  const [sub, pane, ...rest] = argv
  if (!sub || !pane) throw new Error(USAGE)
  if (sub === 'send') {
    const words: string[] = []
    let enter = false
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--') {
        words.push(...rest.slice(i + 1))
        break
      }
      if (rest[i] === '--enter') enter = true
      else words.push(rest[i])
    }
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
    const call: PaneCall = { method: 'pane.read', params: { pane }, json: false }
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') {
        call.json = true
      } else if (rest[i] === '--lines') {
        const lines = Number(rest[++i])
        if (!Number.isInteger(lines) || lines < 1) {
          throw new Error('--lines must be a positive integer')
        }
        call.params.lines = lines
      } else {
        throw new Error(USAGE)
      }
    }
    return call
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
