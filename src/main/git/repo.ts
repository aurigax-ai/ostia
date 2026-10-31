import { execFile } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isInsidePath } from '../platform/pathGuard'
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
  parsePorcelainV2,
  parseShortstat,
  type RepoStatus,
  textLineCount,
  withUntracked,
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

const gitEnv = () => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
})

const NO_PROGRAMS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'safe.bareRepository=explicit',
  '-c',
  'diff.submodule=short',
  '-c',
  'submodule.recurse=false',
]
const NO_HOOKS = ['-c', `core.hooksPath=${devNull}`]

const FILTER_KEY = /^(?:local|worktree)\tfilter\.(.+)\.(clean|smudge|process)$/

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    execFile(
      'git',
      [...NO_PROGRAMS, ...args],
      { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, env: gitEnv() },
      (err, stdout) => done(err ? '' : stdout),
    )
  })
}

async function noRepoFilters(cwd: string): Promise<string[]> {
  const listed = await gitOutput(cwd, [
    'config',
    '--show-scope',
    '--name-only',
    '--get-regexp',
    '^filter\\..*\\.(clean|smudge|process)$',
  ])
  const off: string[] = []
  for (const line of listed.split('\n')) {
    const match = FILTER_KEY.exec(line)
    if (match) off.push('-c', `filter.${match[1]}.${match[2]}=`)
  }
  return off
}

async function run(cwd: string, args: string[], hooks = false): Promise<RunResult> {
  const filters = await noRepoFilters(cwd)
  return new Promise((done) => {
    execFile(
      'git',
      [...NO_PROGRAMS, ...filters, ...(hooks ? [] : NO_HOOKS), ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: MAX_OUTPUT,
        env: gitEnv(),
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        done({ code, stdout, stderr: stderr.toString('utf8') })
      },
    )
  })
}

export async function runOk(cwd: string, args: string[], hooks = false): Promise<Buffer> {
  const res = await run(cwd, args, hooks)
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

export async function worktreeKey(cwd: string): Promise<string | undefined> {
  const res = await run(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
  if (res.code !== 0) return undefined
  const [top, gitDir] = res.stdout.toString('utf8').trim().split('\n')
  return top && gitDir ? `${top}\0${gitDir}` : undefined
}

const SUBMODULES_MAX = 10
const GITLINK = /^160000 [0-9a-f]+ \d\t(.+)$/s

interface Submodule {
  path: string
  dir: string
}

async function submodules(root: string): Promise<Submodule[]> {
  const listed = await run(root, ['ls-files', '-s', '-z'])
  if (listed.code !== 0) return []
  const paths = listed.stdout
    .toString('utf8')
    .split('\0')
    .flatMap((entry) => GITLINK.exec(entry)?.[1] ?? [])
    .slice(0, SUBMODULES_MAX)
  const realRoot = await realpath(root).catch(() => root)
  const found: Submodule[] = []
  for (const path of paths) {
    const dir = await realpath(join(root, path)).catch(() => null)
    if (!dir || dir === realRoot || !isInsidePath(realRoot, dir)) continue
    if (!(await lstat(join(dir, '.git')).catch(() => null))) continue
    const top = await run(dir, ['rev-parse', '--show-toplevel'])
    const toplevel = await realpath(top.stdout.toString('utf8').trim()).catch(() => null)
    if (top.code === 0 && toplevel === dir) found.push({ path, dir })
  }
  return found
}

async function inSubmodule(
  root: string,
  path: string,
): Promise<{ dir: string; path: string } | null> {
  for (const sub of await submodules(root)) {
    if (path.startsWith(`${sub.path}/`))
      return { dir: sub.dir, path: path.slice(sub.path.length + 1) }
  }
  return null
}

async function repoOf(root: string, path: string): Promise<{ dir: string; path: string }> {
  return (await inSubmodule(root, path)) ?? { dir: root, path }
}

const STATUS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=dirty',
]

export async function readStatus(root: string): Promise<RepoStatus> {
  const out = await runOk(root, [...STATUS.slice(0, 2), '--branch', ...STATUS.slice(2)])
  const status = parsePorcelainV2(out.toString('utf8'))
  for (const sub of await submodules(root)) {
    const inner = await run(sub.dir, STATUS)
    if (inner.code !== 0) continue
    for (const change of parsePorcelainV2(inner.stdout.toString('utf8')).changes) {
      status.changes.push({
        ...change,
        path: `${sub.path}/${change.path}`,
        ...(change.origPath ? { origPath: `${sub.path}/${change.origPath}` } : {}),
      })
    }
  }
  return status
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
  const where = await repoOf(root, change.path)
  if (where.dir !== root) {
    const origin = change.origPath ? await repoOf(root, change.origPath) : null
    return diffSides(where.dir, {
      ...change,
      path: where.path,
      ...(origin ? { origPath: origin.path } : {}),
    })
  }
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
  const where = await repoOf(root, change.path)
  if (where.dir !== root) {
    const origin = change.origPath ? await repoOf(root, change.origPath) : null
    return unifiedPatch(where.dir, {
      ...change,
      path: where.path,
      ...(origin ? { origPath: origin.path } : {}),
    })
  }
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']
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
  if (!isInsidePath(realRoot, real)) {
    throw new RepoError('not-changed', `${input} is outside the repository`)
  }
  return relative(realRoot, real).split(sep).join('/')
}

const MAX_COUNTED_UNTRACKED = 500

async function untrackedLines(root: string, path: string): Promise<number> {
  const abs = join(root, path)
  const info = await lstat(abs).catch(() => null)
  if (!info?.isFile() || info.size > MAX_SIDE_BYTES) return 0
  const buf = await readFile(abs).catch(() => null)
  return buf ? textLineCount(buf, BINARY_SNIFF) : 0
}

export async function lineChanges(root: string, untracked: string[]): Promise<LineChanges | null> {
  const res = await run(root, [
    '-c',
    'diff.autoRefreshIndex=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--shortstat',
    '--ignore-submodules=all',
    'HEAD',
  ])
  const tracked = res.code === 0 ? parseShortstat(res.stdout.toString('utf8')) : null
  if (untracked.length === 0) return tracked
  const counted = await Promise.all(
    untracked.slice(0, MAX_COUNTED_UNTRACKED).map((path) => untrackedLines(root, path)),
  )
  const uncounted = new Array<number>(untracked.length - counted.length).fill(0)
  return withUntracked(tracked, [...counted, ...uncounted])
}

const LITERAL = '--literal-pathspecs'

async function byRepo(root: string, paths: string[]): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const where = await repoOf(root, path)
    groups.set(where.dir, [...(groups.get(where.dir) ?? []), where.path])
  }
  return groups
}

export async function stage(root: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return void (await runOk(root, [LITERAL, 'add', '-A', '--', '.']))
  for (const [dir, targets] of await byRepo(root, paths)) {
    await runOk(dir, [LITERAL, 'add', '-A', '--', ...targets])
  }
}

async function hasCommit(dir: string): Promise<boolean> {
  return (await run(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
}

export async function unstage(root: string, paths: string[], hasHead: boolean): Promise<void> {
  const groups = paths.length ? await byRepo(root, paths) : new Map([[root, ['.']]])
  for (const [dir, targets] of groups) {
    if (dir === root ? hasHead : await hasCommit(dir)) {
      await runOk(dir, [LITERAL, 'reset', '-q', 'HEAD', '--', ...targets])
    } else {
      await runOk(dir, [
        LITERAL,
        'rm',
        '-q',
        '-r',
        '--cached',
        '--ignore-unmatch',
        '--',
        ...targets,
      ])
    }
  }
}

export async function discard(root: string, changes: FileChange[]): Promise<void> {
  const tracked = await byRepo(
    root,
    changes.filter((c) => c.area === 'unstaged').map((c) => c.path),
  )
  const untracked = await byRepo(
    root,
    changes.filter((c) => c.area === 'untracked').map((c) => c.path),
  )
  for (const [dir, paths] of tracked) await runOk(dir, [LITERAL, 'checkout', '-q', '--', ...paths])
  for (const [dir, paths] of untracked)
    await runOk(dir, [LITERAL, 'clean', '-q', '-f', '--', ...paths])
}

export async function commit(root: string, message: string): Promise<string> {
  await runOk(root, ['commit', '-q', '-m', message], true)
  return (await runOk(root, ['rev-parse', 'HEAD'])).toString('utf8').trim()
}

export async function log(root: string, limit: number): Promise<CommitSummary[]> {
  const res = await run(root, [
    'log',
    `-n${limit}`,
    `--format=${LOG_FORMAT}`,
    '--no-color',
    '--no-show-signature',
  ])
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
    '--no-show-signature',
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
    (
      await runOk(root, ['log', '-n1', '--no-show-signature', `--format=${LOG_FORMAT}`, sha])
    ).toString('utf8'),
  )
  const parent = await firstParent(root, sha)
  const out = parent
    ? await runOk(root, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '-z',
        '-M',
        parent,
        sha,
      ])
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
  const out = await runOk(root, [LITERAL, 'blame', '--no-textconv', '--porcelain', '--', rel])
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
