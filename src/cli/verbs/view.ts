import { readFileSync, statSync } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { viewJsonSchema } from '../../shared/viewSchema'
import {
  VIEW_FILE_MAX_BYTES,
  type ViewPlacement,
  type ViewProblem,
  type ViewStatus,
  formatViewProblem,
  parseViewText,
  viewNameOf,
} from '../../shared/views'
import { parseArgs } from '../common/args'

export const VIEW_USAGE =
  'ostia view: usage: view list [--json] | validate <file> | open <name> | schema'

interface ViewSummary {
  name: string
  title: string
  placement: ViewPlacement | null
  status: ViewStatus
  file: string
  stale: boolean
  problems: ViewProblem[]
}

export function isOfflineViewVerb(argv: readonly string[]): boolean {
  return argv[0] === 'view' && (argv[1] === 'validate' || argv[1] === 'schema')
}

function validate(file: string | undefined): number {
  if (!file) {
    console.error(VIEW_USAGE)
    return 1
  }
  const path = resolvePath(process.cwd(), file)
  let text: string
  try {
    const stat = statSync(path)
    if (stat.size > VIEW_FILE_MAX_BYTES) {
      console.error(`${file}: larger than ${VIEW_FILE_MAX_BYTES / 1024} KiB`)
      return 1
    }
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`${file}: ${(err as Error).message}`)
    return 1
  }
  const res = parseViewText(text)
  const nameProblem = viewNameOf(basename(path))
    ? null
    : 'the file name must be <name>.json with a lowercase name (a-z, 0-9, -; up to 40 characters)'
  if (!res.ok) {
    for (const p of res.problems) console.error(formatViewProblem(file, p))
    if (nameProblem) console.error(`${file}: ${nameProblem}`)
    return 1
  }
  if (nameProblem) {
    console.error(`${file}: ${nameProblem}`)
    return 1
  }
  const sources = res.doc.sources.length > 0 ? res.doc.sources.join(', ') : 'none'
  console.log(`ok: "${res.doc.title}" (${res.doc.placement}), data: ${sources}`)
  return 0
}

export function runOfflineViewVerb(argv: readonly string[]): number {
  if (argv[1] === 'schema') {
    console.log(JSON.stringify(viewJsonSchema(), null, 2))
    return 0
  }
  return validate(argv[2])
}

export async function runViewVerb(conn: MessageConnection, argv: readonly string[]): Promise<void> {
  const [sub, ...rest] = argv
  if (sub === 'list') {
    const { json } = parseArgs(rest, { booleans: { json: '--json' } }).booleans
    const listing = await conn.sendRequest<{ dir: string; views: ViewSummary[] }>('view.list')
    if (json) {
      console.log(JSON.stringify(listing, null, 2))
      return
    }
    console.log(`# ${listing.dir}`)
    for (const v of listing.views) {
      const problems = v.problems.length > 0 ? `\t${v.problems.length} problem(s)` : ''
      console.log([v.name, v.status, v.placement ?? '-', v.title].join('\t') + problems)
    }
    return
  }
  if (sub === 'open' && rest[0]) {
    const res = await conn.sendRequest<{ ok: boolean; error?: string; message?: string }>(
      'view.open',
      { name: rest[0] },
    )
    if (res.ok) {
      console.log('ok')
      return
    }
    console.error(`ostia view open: ${res.message ?? res.error ?? 'failed'}`)
    process.exitCode = 1
    return
  }
  console.error(VIEW_USAGE)
  process.exitCode = 1
}
