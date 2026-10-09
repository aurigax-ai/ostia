import type { MessageConnection } from 'vscode-jsonrpc/node'
import { FlagError, parseArgs } from '../common/args'

export const GIT_USAGE = `usage: ostia git <command>
  status                         branch, upstream and change counts (JSON)
  changes                        changed files: staged, unstaged, untracked (JSON)
  diff <path> [--staged]         unified diff of one changed file (JSON)
  open <path> [--staged]         open a changed file in the diff view
  log [--limit <n>] [--json]     recent commits
  blame <file> [--json]          who last changed each line of a file
  stage <path...> | --all        stage paths
  unstage <path...> | --all      unstage paths
  commit -m <message>            commit the staged changes`

export const PORTS_USAGE = `usage: ostia ports ls [--all]
  ls [--all]   listening ports and ssh hosts of your workspace (JSON); --all needs all-workspaces`

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

export function portsRequest(argv: readonly string[]): BoardRequest | null {
  const [sub, ...rest] = argv
  if (sub !== 'ls') return null
  const { positional, booleans } = parseArgs(rest, { booleans: { all: '--all' } })
  return positional.length === 0 ? { method: 'ports.ls', params: { all: booleans.all } } : null
}

async function runBoardVerb(
  conn: MessageConnection,
  verb: string,
  argv: readonly string[],
  parse: (argv: readonly string[]) => BoardRequest | null,
  usage: string,
): Promise<void> {
  let request: BoardRequest | null
  try {
    request = parse(argv)
  } catch (err) {
    if (!(err instanceof FlagError)) throw err
    console.error(`ostia ${verb}: ${err.message}`)
    process.exitCode = 1
    return
  }
  if (!request) {
    console.error(usage)
    process.exitCode = 1
    return
  }
  const res = await conn.sendRequest<BoardReply>(request.method, request.params)
  if (!res.ok) {
    const detail = res.message ? `${res.error}: ${res.message}` : res.error
    console.error(`ostia: ${verb} ${argv[0]} failed (${detail})`)
    process.exitCode = 1
  } else if (res.text !== undefined) {
    if (res.text) console.log(res.text)
  } else {
    console.log(JSON.stringify(res.data, null, 2))
  }
}

export function runGitVerb(conn: MessageConnection, argv: readonly string[]): Promise<void> {
  return runBoardVerb(conn, 'git', argv, gitRequest, GIT_USAGE)
}

export function runPortsVerb(conn: MessageConnection, argv: readonly string[]): Promise<void> {
  return runBoardVerb(conn, 'ports', argv, portsRequest, PORTS_USAGE)
}
