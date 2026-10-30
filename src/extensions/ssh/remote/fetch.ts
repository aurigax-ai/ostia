import { basename } from 'node:path'
import type { Translate } from '@aurigax-ai/ostia-extension-sdk'
import {
  type CommandHandler,
  cliArgs,
  type ExtensionResult,
  failure,
  ok,
} from '@aurigax-ai/ostia-extension-sdk'
import {
  DIFF_TEXT_MAX,
  type DiffContent,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { fetchedRef, repoIdOf, repoSlug } from '../../../shared/remote/remoteHandoff'
import { parseRemoteRef } from '../../../shared/remote/remoteRef'
import { type ConnectPlan, hostKey, planConnect } from '../plan'
import { classify, type RunnerClient } from './runnerClient'
import { type Consenting, consented, type Git, GitFailure, gitText, transferArgs } from './transfer'

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames']

export interface FetchDeps extends Consenting {
  translate: (locale: string | undefined) => Translate
  client: (plan: ConnectPlan) => RunnerClient
  git: Git
  openDiff: (diff: DiffContent & { workspaceId?: string }) => Promise<ExtensionResult>
}

interface Change {
  status: string
  path: string
}

function changesOf(nameStatus: string): Change[] {
  const words = nameStatus.split('\0').filter(Boolean)
  const changes: Change[] = []
  for (let i = 0; i + 1 < words.length; i += 2)
    changes.push({ status: words[i], path: words[i + 1] })
  return changes
}

async function side(git: Git, cwd: string, spec: string): Promise<string | null> {
  const run = await git(['cat-file', 'blob', spec], cwd)
  if (run.code !== 0 || run.stdout.length > DIFF_TEXT_MAX || run.stdout.includes('\0')) return null
  return run.stdout
}

async function firstTextDiff(
  deps: FetchDeps,
  cwd: string,
  range: { base: string; head: string },
  changes: readonly Change[],
): Promise<DiffContent | null> {
  for (const { status, path } of changes) {
    const original = status === 'A' ? '' : await side(deps.git, cwd, `${range.base}:${path}`)
    const modified = status === 'D' ? '' : await side(deps.git, cwd, `${range.head}:${path}`)
    if (original !== null && modified !== null) {
      return { title: path, original, modified, path }
    }
  }
  return null
}

async function localRepoId(git: Git, cwd: string): Promise<string> {
  const root = (await gitText(git, cwd, ['rev-parse', '--show-toplevel'])).trim()
  const first = (await gitText(git, cwd, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n')[0]
  return repoIdOf(repoSlug(basename(root)), first.trim())
}

export function remoteFetch(deps: FetchDeps): CommandHandler {
  return async (args, caller): Promise<ExtensionResult> => {
    const t = deps.translate(caller.locale)
    if (caller.sandboxed) return failure('sandboxed', t('sandboxed'))
    if (caller.manager) return failure('human-only', t('humanOnly'))
    const target = parseRemoteRef(cliArgs(args)?.argv[0] ?? '')
    const plan = target ? planConnect([target.host]) : null
    if (!target || !plan) return failure('invalid-args', t('fetchUsage'))
    if (!caller.cwd) return failure('no-folder', t('fetchNoFolder'))
    const cwd = caller.cwd
    const { host, pane: jobId } = target
    try {
      const repoId = await localRepoId(deps.git, cwd)
      const allowed = await consented(deps, `fetch:${hostKey(plan)}:${repoId}`, {
        title: t('fetchTitle'),
        message: t('fetchMessage', { repo: repoId, host }),
        detail: t('fetchNote'),
        confirmLabel: t('fetch'),
        cancelLabel: t('dontFetch'),
      })
      if (!allowed) return failure('refused', t('fetchRefused'))
      const client = deps.client(plan)
      await client.ensure()
      const result = await client.result(jobId)
      if (result.repo !== repoId) {
        return failure('wrong-repo', t('wrongRepo', { repo: result.repo }))
      }
      const ref = fetchedRef(host, jobId)
      await gitText(deps.git, cwd, [
        ...transferArgs(plan),
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        `${plan.destination}:.ostia/node/repos/${result.repo}.git`,
        `+refs/heads/${result.branch}:${ref}`,
      ])
      const fetched = (await gitText(deps.git, cwd, ['rev-parse', '--verify', ref])).trim()
      if (fetched !== result.head) return failure('changed', t('fetchChanged', { ref }))
      const range = { base: result.base, head: fetched }
      const spec = `${range.base}..${range.head}`
      const stat = await gitText(deps.git, cwd, ['diff', '--stat=120', ...DIFF_FLAGS, spec])
      const changes = changesOf(
        await gitText(deps.git, cwd, ['diff', '--name-status', '-z', ...DIFF_FLAGS, spec]),
      )
      const lines = [`${ref} ${fetched.slice(0, 8)}`]
      lines.push(stat.trim() || t('noChanges'))
      if (result.dirty) lines.push(t('remoteDirty', { ref: target.pane }))
      const diff = await firstTextDiff(deps, cwd, range, changes)
      if (diff) {
        await deps.openDiff({
          ...diff,
          title: `${ref}: ${diff.title}`,
          ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
        })
      }
      return ok(lines.join('\n'), { ref, head: fetched, dirty: result.dirty })
    } catch (err) {
      if (err instanceof GitFailure) return failure('git-failed', err.message)
      const failed = classify(err)
      return failure(failed.code, failed.detail ?? failed.message)
    }
  }
}
