import { basename } from 'node:path'
import type { RepoHandoff } from '../../shared/remote/remoteHandoff'
import { repoIdOf, repoSlug } from '../../shared/remote/remoteHandoff'
import { RepoError, readStatus, repoRoot, runOk } from './repo'

export type RepoSnapshot =
  | { ok: true; root: string; repo: RepoHandoff }
  | { ok: false; error: 'not-a-repo' | 'dirty'; message: string }

const NOT_A_REPO = {
  ok: false as const,
  error: 'not-a-repo' as const,
  message: 'run it from a git repository with a commit: v1 moves committed code only',
}

const DIRTY = {
  ok: false as const,
  error: 'dirty' as const,
  message: 'the working tree has uncommitted or untracked changes: commit or stash first',
}

export async function repoSnapshot(cwd: string): Promise<RepoSnapshot> {
  const root = await repoRoot(cwd)
  if (!root) return NOT_A_REPO
  try {
    const head = (await runOk(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim()
    const first = (await runOk(root, ['rev-list', '--max-parents=0', 'HEAD']))
      .toString()
      .split('\n')[0]
      ?.trim()
    if (!first) return NOT_A_REPO
    if ((await readStatus(root)).changes.length > 0) return DIRTY
    const name = repoSlug(basename(root))
    return { ok: true, root, repo: { id: repoIdOf(name, first), name, head } }
  } catch (err) {
    if (err instanceof RepoError) return NOT_A_REPO
    throw err
  }
}
