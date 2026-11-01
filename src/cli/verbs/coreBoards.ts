import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from '../common/args'
import { fail, failVerb } from '../common/failure'
import { usageOf } from '../common/usageTable'

export interface BoardRequest {
  method: string
  params: Record<string, unknown>
}

interface BoardReply {
  ok: boolean
  error?: string
  message?: string
  text?: string
  data?: unknown
}

export function gitRequest(argv: readonly string[]): BoardRequest | null {
  const [sub, ...rest] = argv
  switch (sub) {
    case 'status':
    case 'changes':
      return rest.length === 0 ? { method: `git.${sub}`, params: {} } : null
    case 'diff':
    case 'open': {
      const { positional, booleans } = parseArgs(rest, { booleans: { staged: '--staged' } })
      if (positional.length > 1) return null
      return { method: `git.${sub}`, params: { path: positional[0], staged: booleans.staged } }
    }
    case 'log': {
      const { positional, values, booleans } = parseArgs(rest, {
        values: { limit: '--limit' },
        booleans: { json: '--json' },
      })
      if (positional.length > 0) return null
      const limit = values.limit === undefined ? undefined : Number(values.limit)
      return { method: 'git.log', params: { limit, text: !booleans.json } }
    }
    case 'blame': {
      const { positional, booleans } = parseArgs(rest, { booleans: { json: '--json' } })
      if (positional.length > 1) return null
      return { method: 'git.blame', params: { path: positional[0], text: !booleans.json } }
    }
    case 'stage':
    case 'unstage': {
      const { positional, booleans } = parseArgs(rest, { booleans: { all: '--all' } })
      return { method: `git.${sub}`, params: { paths: positional, all: booleans.all } }
    }
    case 'commit': {
      const { positional, lists } = parseArgs(rest, { lists: { message: '-m, --message' } })
      if (positional.length > 0) return null
      return { method: 'git.commit', params: { message: lists.message.join('\n\n') } }
    }
    default:
      return null
  }
}

const NOT_REMOTE_REPLIES: ReadonlySet<string> = new Set([
  'not-remote',
  'unknown-extension',
  'extension-disabled',
])

export function portsRequest(argv: readonly string[]): BoardRequest | null {
  const [sub, ...rest] = argv
  if (sub === 'list') {
    const { positional, booleans } = parseArgs(rest, { booleans: { all: '--all' } })
    return positional.length === 0 ? { method: 'ports.ls', params: { all: booleans.all } } : null
  }
  if (sub === 'forward' || sub === 'stop') {
    const { positional, values } = parseArgs(rest, { values: { local: '--local' } })
    const remote = positional[0]
    if (positional.length !== 1 || !/^\d{1,5}$/.test(remote)) return null
    const { local } = values
    if (sub === 'stop' && local !== undefined) return null
    if (local !== undefined && !/^\d{1,6}$/.test(local)) return null
    return {
      method: `ports.${sub}`,
      params: { remote: Number(remote), ...(local === undefined ? {} : { local: Number(local) }) },
    }
  }
  return null
}

async function runBoardVerb(
  conn: MessageConnection,
  verb: string,
  argv: readonly string[],
  parse: (argv: readonly string[]) => BoardRequest | null,
): Promise<void> {
  let request: BoardRequest | null
  try {
    request = parse(argv)
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    failVerb(err.message)
    return
  }
  if (!request) {
    fail(usageOf(verb))
    return
  }
  const res = await conn.sendRequest<BoardReply>(request.method, request.params)
  report(verb, argv, res)
}

function report(verb: string, argv: readonly string[], res: BoardReply): void {
  if (!res.ok) {
    const detail = res.message ? `${res.error}: ${res.message}` : res.error
    fail(`ostia ${verb} ${argv[0]}: ${detail}`)
  } else if (res.text !== undefined) {
    if (res.text) console.log(res.text)
  } else {
    console.log(JSON.stringify(res.data))
  }
}

export function runGitVerb(conn: MessageConnection, argv: readonly string[]): Promise<void> {
  return runBoardVerb(conn, 'git', argv, gitRequest)
}

export async function runPortsVerb(
  conn: MessageConnection,
  argv: readonly string[],
): Promise<void> {
  if (argv.length === 1 && argv[0] === 'list') {
    const remote = await conn.sendRequest<BoardReply>('ports.forwards', {})
    if (remote.ok || !NOT_REMOTE_REPLIES.has(remote.error ?? ''))
      return report('ports', argv, remote)
  }
  return runBoardVerb(conn, 'ports', argv, portsRequest)
}
