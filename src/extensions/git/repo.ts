import { execFile } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type BlameLine,
  type CommitFile,
  type CommitSummary,
  GRAPH_FORMAT,
  type GraphCommit,
  LOG_FORMAT,
  parseBlamePorcelain,
  parseGraphLog,
  parseLog,
  parseNameStatus,
} from './history'
import { BRANCH_REF_FORMAT, type BranchRef, parseBranchRefs } from './scope'
import {
  type ChangeArea,
  type FileChange,
  type LineChanges,
  type RepoStatus,
  parsePorcelainV2,
  parseShortstat,
} from './status'

const MAX_OUTPUT = 32 * 1024 * 1024
export const MAX_SIDE_BYTES = 2 * 1024 * 1024
const BINARY_SNIFF = 8000
const MAX_ERROR_TEXT = 4000

export class RepoError extends Error {
  constructor(
    public readonly code:
      | 'not-a-repo'
      | 'binary'
      | 'too-large'
      | 'not-changed'
      | 'git-failed'
      | 'invalid-args'
      | 'unknown-commit',
    message: string,
  ) {
    super(message)
  }
}

interface RunResult {
  code: number
  stdout: Buffer
  stderr: string
}

function run(cwd: string, args: string[]): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        done({ code, stdout, stderr: stderr.toString('utf8') })
      },
    )
  })
}

async function runOk(cwd: string, args: string[]): Promise<Buffer> {
  const res = await run(cwd, args)
  if (res.code !== 0)
    throw new RepoError(
      'git-failed',
      res.stderr.trim() ||
        res.stdout.toString('utf8', 0, MAX_ERROR_TEXT).trim() ||
        `git ${args.find((a) => !a.startsWith('-')) ?? ''} failed`,
    )
  return res.stdout
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const res = await run(cwd, ['rev-parse', '--show-toplevel'])
  if (res.code !== 0) return null
  const root = res.stdout.toString('utf8').trim()
  return root || null
}

export async function readStatus(root: string): Promise<RepoStatus> {
  const out = await runOk(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ])
  return parsePorcelainV2(out.toString('utf8'))
}

function asText(buf: Buffer): string {
  if (buf.length > MAX_SIDE_BYTES) throw new RepoError('too-large', 'file is too large to diff')
  if (buf.subarray(0, BINARY_SNIFF).includes(0)) throw new RepoError('binary', 'binary file')
  return buf.toString('utf8')
}

async function blob(root: string, spec: string): Promise<string> {
  const res = await run(root, ['cat-file', 'blob', spec])
  return res.code === 0 ? asText(res.stdout) : ''
}

async function worktree(root: string, path: string): Promise<string> {
  const full = join(root, path)
  try {
    if ((await lstat(full)).isSymbolicLink()) return await readlink(full)
    return asText(await readFile(full))
  } catch (err) {
    if (err instanceof RepoError) throw err
    return ''
  }
}

export interface DiffSides {
  original: string
  modified: string
}

export async function diffSides(root: string, change: FileChange): Promise<DiffSides> {
  const base = change.origPath ?? change.path
  if (change.area === 'staged') {
    return {
      original: await blob(root, `HEAD:${base}`),
      modified: change.code === 'D' ? '' : await blob(root, `:${change.path}`),
    }
  }
  if (change.area === 'unstaged') {
    return {
      original: await blob(root, `:${change.path}`),
      modified: change.code === 'D' ? '' : await worktree(root, change.path),
    }
  }
  if (change.area === 'conflicted') {
    return {
      original: await blob(root, `HEAD:${change.path}`),
      modified: await worktree(root, change.path),
    }
  }
  return { original: '', modified: await worktree(root, change.path) }
}

export async function unifiedPatch(root: string, change: FileChange): Promise<string> {
  const common = ['--no-color', '--no-ext-diff']
  if (change.area === 'untracked') {
    const res = await run(root, ['diff', ...common, '--no-index', '--', '/dev/null', change.path])
    if (res.code !== 0 && res.code !== 1) throw new RepoError('git-failed', res.stderr.trim())
    return res.stdout.toString('utf8')
  }
  const cached = change.area === 'staged' ? ['--cached'] : []
  const paths = change.origPath ? [change.origPath, change.path] : [change.path]
  const out = await runOk(root, ['diff', ...common, ...cached, '-M', '--', ...paths])
  return out.toString('utf8')
}

export async function repoRelative(root: string, cwd: string, input: string): Promise<string> {
  const base = await realpath(cwd).catch(() => cwd)
  const abs = isAbsolute(input) ? input : resolve(base, input)
  const real = await realpath(abs).catch(() => abs)
  const realRoot = await realpath(root).catch(() => root)
  const rel = relative(realRoot, real)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new RepoError('not-changed', `${input} is outside the repository`)
  }
  return rel.split(sep).join('/')
}

export async function lineChanges(root: string): Promise<LineChanges | null> {
  const res = await run(root, ['-c', 'diff.autoRefreshIndex=false', 'diff', '--shortstat', 'HEAD'])
  return res.code === 0 ? parseShortstat(res.stdout.toString('utf8')) : null
}

const LITERAL = '--literal-pathspecs'

export async function stage(root: string, paths: string[]): Promise<void> {
  await runOk(root, [LITERAL, 'add', '-A', '--', ...(paths.length ? paths : ['.'])])
}

export async function unstage(root: string, paths: string[], hasHead: boolean): Promise<void> {
  const targets = paths.length ? paths : ['.']
  if (hasHead) await runOk(root, [LITERAL, 'reset', '-q', 'HEAD', '--', ...targets])
  else
    await runOk(root, [LITERAL, 'rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...targets])
}

export async function discard(root: string, changes: FileChange[]): Promise<void> {
  const tracked = changes.filter((c) => c.area === 'unstaged').map((c) => c.path)
  const untracked = changes.filter((c) => c.area === 'untracked').map((c) => c.path)
  if (tracked.length) await runOk(root, [LITERAL, 'checkout', '-q', '--', ...tracked])
  if (untracked.length) await runOk(root, [LITERAL, 'clean', '-q', '-f', '--', ...untracked])
}

export async function commit(root: string, message: string): Promise<string> {
  await runOk(root, ['commit', '-q', '-m', message])
  return (await runOk(root, ['rev-parse', 'HEAD'])).toString('utf8').trim()
}

export async function log(root: string, limit: number): Promise<CommitSummary[]> {
  const res = await run(root, ['log', `-n${limit}`, `--format=${LOG_FORMAT}`, '--no-color'])
  if (res.code !== 0) return []
  return parseLog(res.stdout.toString('utf8'))
}

export async function branchRefs(root: string, head: string | null): Promise<BranchRef[]> {
  const out = await runOk(root, [
    'for-each-ref',
    `--format=${BRANCH_REF_FORMAT}`,
    'refs/heads',
    'refs/remotes',
  ])
  return parseBranchRefs(out.toString('utf8'), head)
}

export async function graphLog(
  root: string,
  revisions: string[],
  limit: number,
): Promise<GraphCommit[]> {
  const out = await runOk(root, [
    'log',
    '--date-order',
    '--decorate=full',
    '--no-color',
    `-n${limit}`,
    `--format=${GRAPH_FORMAT}`,
    ...revisions,
  ])
  return parseGraphLog(out.toString('utf8'))
}

const SHA = /^[0-9a-f]{4,64}$/

async function resolveCommit(root: string, sha: string): Promise<string> {
  if (!SHA.test(sha)) throw new RepoError('invalid-args', `${sha} is not a commit id`)
  const res = await run(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  if (res.code !== 0) throw new RepoError('unknown-commit', `no commit ${sha}`)
  return res.stdout.toString('utf8').trim()
}

async function firstParent(root: string, sha: string): Promise<string | null> {
  const res = await run(root, ['rev-parse', '--verify', '--quiet', `${sha}^1`])
  return res.code === 0 ? res.stdout.toString('utf8').trim() : null
}

export interface CommitDetail {
  commit: CommitSummary
  parent: string | null
  files: CommitFile[]
}

export async function commitDetail(root: string, input: string): Promise<CommitDetail> {
  const sha = await resolveCommit(root, input)
  const [summary] = parseLog(
    (await runOk(root, ['log', '-n1', `--format=${LOG_FORMAT}`, sha])).toString('utf8'),
  )
  const parent = await firstParent(root, sha)
  const out = parent
    ? await runOk(root, ['diff', '--no-color', '--name-status', '-z', '-M', parent, sha])
    : await runOk(root, ['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--name-status', sha])
  const files = parseNameStatus(out.toString('utf8'))
  return { commit: summary, parent, files }
}

export async function commitSides(
  root: string,
  detail: CommitDetail,
  file: CommitFile,
): Promise<DiffSides> {
  const base = file.origPath ?? file.path
  return {
    original:
      detail.parent && file.code !== 'A' ? await blob(root, `${detail.parent}:${base}`) : '',
    modified: file.code === 'D' ? '' : await blob(root, `${detail.commit.sha}:${file.path}`),
  }
}

export async function blame(root: string, rel: string): Promise<BlameLine[]> {
  const out = await runOk(root, [LITERAL, 'blame', '--porcelain', '--', rel])
  if (out.length > MAX_SIDE_BYTES * 4)
    throw new RepoError('too-large', 'file is too large to blame')
  return parseBlamePorcelain(out.toString('utf8'))
}

export function pickChange(
  changes: FileChange[],
  path: string,
  preferred?: ChangeArea,
): FileChange | null {
  const matches = changes.filter((c) => c.path === path || c.origPath === path)
  if (matches.length === 0) return null
  if (preferred) return matches.find((c) => c.area === preferred) ?? null
  const order: ChangeArea[] = ['conflicted', 'unstaged', 'untracked', 'staged']
  for (const area of order) {
    const found = matches.find((c) => c.area === area)
    if (found) return found
  }
  return matches[0]
}
