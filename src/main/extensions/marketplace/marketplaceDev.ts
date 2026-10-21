import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isInsideDir } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import type { DevSource, MarketplaceError } from '../../../shared/extensions/marketplace'
import { isRealDirectory } from './marketplaceCatalog'
import { GitError, type GitRunner, normalizeMarketplaceUrl, runGit } from './marketplaceSources'

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

export type StagedDevSource =
  | { ok: true; dir: string; label: string; cleanup: () => void }
  | { ok: false; error: MarketplaceError; detail?: string }

function folder(path: unknown): StagedDevSource {
  if (typeof path !== 'string' || !isAbsolute(path) || !isRealDirectory(path)) {
    return { ok: false, error: 'invalid-source', detail: 'a folder path' }
  }
  return { ok: true, dir: realpathSync(path), label: `folder ${path}`, cleanup: () => {} }
}

async function branch(
  source: Extract<DevSource, { kind: 'git' }>,
  scratch: string,
  git: GitRunner,
): Promise<StagedDevSource> {
  const url = normalizeMarketplaceUrl(source.url)
  const sub = source.path ?? ''
  if (!url || !BRANCH_PATTERN.test(source.branch) || (sub !== '' && !isInsideDir('/root', sub))) {
    return { ok: false, error: 'invalid-source', detail: 'a repository, a branch and a folder' }
  }
  const work = mkdtempSync(join(scratch, 'dev-'))
  const cleanup = (): void => rmSync(work, { recursive: true, force: true })
  try {
    await git([
      'clone',
      '--depth',
      '1',
      '--no-tags',
      '--single-branch',
      '--branch',
      source.branch,
      '--no-recurse-submodules',
      '-c',
      'core.symlinks=false',
      '--',
      url,
      join(work, 'repo'),
    ])
  } catch (err) {
    cleanup()
    const error = err instanceof GitError ? err.code : 'clone-failed'
    return { ok: false, error, detail: (err as Error).message }
  }
  const dir = join(work, 'repo', sub)
  if (!isRealDirectory(dir) || !isInsideDir(join(work, 'repo'), dir)) {
    cleanup()
    return { ok: false, error: 'invalid-source', detail: `no folder ${sub || '.'} on the branch` }
  }
  const label = `git ${url} ${source.branch}${sub ? ` ${sub}` : ''}`
  return { ok: true, dir, label, cleanup }
}

export async function stageDevSource(
  source: unknown,
  scratch: string,
  git: GitRunner = runGit,
): Promise<StagedDevSource> {
  const { kind, path, url, branch: name } = (source ?? {}) as Record<string, unknown>
  if (kind === 'folder') return folder(path)
  if (kind === 'git' && typeof url === 'string' && typeof name === 'string') {
    return branch(source as Extract<DevSource, { kind: 'git' }>, scratch, git)
  }
  return { ok: false, error: 'invalid-source' }
}
