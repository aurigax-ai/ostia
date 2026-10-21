import type { ExecOptions, ExecResult } from '@aurigax-ai/ostia-extension-sdk'

export const GATHER_MAX_CHARS = 1500
const GATHER_FILES_MAX = 15
const EXEC_TIMEOUT_MS = 20_000
const EXEC_OUTPUT_BYTES = 64 * 1024

export type GatherExec = (opts: ExecOptions) => Promise<ExecResult>

async function lines(exec: GatherExec, workspaceId: string, command: string[]): Promise<string[]> {
  const res = await exec({
    workspaceId,
    command,
    timeoutMs: EXEC_TIMEOUT_MS,
    maxOutputBytes: EXEC_OUTPUT_BYTES,
  })
  if (!res.ok || res.timedOut || res.exitCode > 1) return []
  return res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
}

function section(title: string, body: readonly string[], keep: number): string[] {
  return body.length === 0 ? [] : [`${title}:`, ...body.slice(0, keep).map((l) => `  ${l}`)]
}

async function matchingFiles(exec: GatherExec, workspaceId: string, words: readonly string[]) {
  const patterns = words.flatMap((w) => ['-e', w])
  const found = await lines(exec, workspaceId, ['rg', '-l', '-i', '--max-count', '1', ...patterns])
  if (found.length > 0) return found
  return lines(exec, workspaceId, ['git', 'grep', '-l', '-i', ...patterns])
}

async function githubLines(
  exec: GatherExec,
  workspaceId: string,
  words: readonly string[],
): Promise<string[]> {
  const search = words.join(' ')
  const view = '.[] | "#\\(.number) \\(.state) \\(.title)"'
  const list = (noun: 'issue' | 'pr') =>
    lines(exec, workspaceId, [
      'gh',
      noun,
      'list',
      '--state',
      'all',
      '--limit',
      '5',
      '--search',
      search,
      '--json',
      'number,title,state',
      '--jq',
      view,
    ])
  const [issues, prs] = await Promise.all([list('issue'), list('pr')])
  return [...issues.map((l) => `issue ${l}`), ...prs.map((l) => `pr ${l}`)]
}

export async function gather(
  exec: GatherExec,
  workspaceId: string,
  words: readonly string[],
): Promise<string> {
  const grep = words.flatMap((w) => [`--grep=${w}`])
  const [log, status, files, github] = await Promise.all([
    lines(exec, workspaceId, ['git', 'log', '--oneline', '-20', '-i', ...grep]),
    lines(exec, workspaceId, ['git', 'status', '--short']),
    matchingFiles(exec, workspaceId, words),
    githubLines(exec, workspaceId, words),
  ])
  const text = [
    ...section('commits that mention it', log, 6),
    ...section('uncommitted', status, 5),
    ...section('files that mention it', files, GATHER_FILES_MAX),
    ...section('issues and pull requests', github, 6),
  ].join('\n')
  if (text === '') return 'nothing found for those words'
  return text.length <= GATHER_MAX_CHARS ? text : `${text.slice(0, GATHER_MAX_CHARS - 1)}…`
}
