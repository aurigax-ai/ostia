import { resolve as resolvePath } from 'node:path'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CmuxImportReport, CmuxLoss, CmuxSkipReason } from '../shared/cmuxSession'
import type { CommandResult } from '../shared/types'
import { MAX_PANES, MAX_WORKSPACES } from '../shared/workspaceLimits'
import { parseArgs } from './args'

export const CMUX_IMPORT_USAGE = 'usage: ostia workspace import-cmux [session-file] [--json]'

const CMUX_IMPORT_COMMAND = 'workspace.importCmux'

const PROGRAMS =
  'running programs are not restarted: every terminal starts a new shell in its folder'

const SKIP_TEXT: Record<CmuxSkipReason, string> = {
  exists: 'already in Ostia',
  limit: `Ostia keeps at most ${MAX_WORKSPACES} workspaces`,
  window: 'its new window did not open',
}

const LOSS_TEXT: Record<CmuxLoss, (detail: string) => string> = {
  scrollback: () => 'scrollback',
  'agent-resume': (agent) =>
    `${agent} session not started; press Resume in the pane to continue it`,
  agent: (agent) => `${agent} was running and is not restarted`,
  surface: (type) => `${type} pane, which Ostia has no counterpart for`,
  remote: () => 'remote connection; it opens as a local shell',
  canvas: () => 'canvas layout; it opens as splits',
  'browser-history': () => 'back and forward history',
  group: (group) => `group "${group}"`,
  panes: (n) => `${n} panes past the limit of ${MAX_PANES} per workspace`,
  layout: () => 'splits nested deeper than Ostia allows; the innermost ones open as tabs',
}

interface CmuxImportArgs {
  path?: string
  json: boolean
}

export function parseCmuxImportArgs(argv: readonly string[], cwd: string): CmuxImportArgs {
  const { positional, booleans } = parseArgs(argv, { booleans: { json: '--json' } })
  if (positional.length > 1) throw new Error(CMUX_IMPORT_USAGE)
  const [file] = positional
  return { ...(file ? { path: resolvePath(cwd, file) } : {}), json: booleans.json }
}

export function formatCmuxImport(report: CmuxImportReport): string[] {
  const lines = [`read ${report.path}`]
  for (const w of report.imported) lines.push(`imported\t${w.name}\t${w.panes} panes`)
  for (const s of report.skipped) lines.push(`skipped\t${s.name}\t${SKIP_TEXT[s.reason]}`)
  if (report.imported.length === 0) {
    lines.push('nothing new to import')
    return lines
  }
  lines.push('not carried over:', `  ${PROGRAMS}`)
  for (const entry of report.notCarried) {
    const where = entry.pane ? `${entry.workspace} > ${entry.pane}` : entry.workspace
    lines.push(`  ${where}: ${LOSS_TEXT[entry.loss](entry.detail ?? '')}`)
  }
  return lines
}

export async function runCmuxImportVerb(
  conn: MessageConnection,
  argv: readonly string[],
  cwd: string,
): Promise<number> {
  let args: CmuxImportArgs
  try {
    args = parseCmuxImportArgs(argv, cwd)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  const res = await conn.sendRequest<CommandResult<CmuxImportReport>>('command.exec', {
    id: CMUX_IMPORT_COMMAND,
    args: args.path ? { path: args.path } : {},
  })
  if (!res.ok || !res.result) {
    console.error(`ostia workspace import-cmux: ${res.ok ? 'no result' : res.error?.message}`)
    return 1
  }
  if (args.json) console.log(JSON.stringify(res.result, null, 2))
  else for (const line of formatCmuxImport(res.result)) console.log(line)
  return 0
}
