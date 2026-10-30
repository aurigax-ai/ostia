import type { RemoteAgent } from './remoteSetup'

export const START_WAIT_MS = 60_000
export const PROMPT_MAX = 16_000

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}-[0-9a-f]{12}$/
const COMMIT = /^[0-9a-f]{40}$/

export interface RepoHandoff {
  id: string
  name: string
  head: string
}

export interface RemoteStartInput {
  agent: RemoteAgent
  prompt: string
  model?: string
  title: string
  workspaceId: string
  root: string
  repo: RepoHandoff
}

export type RemoteStartAnswer =
  | { ok: true; jobId: string; ref: string; paneId: string; session?: string }
  | { ok: false; error: string; message: string }

export type JobOutcome =
  | { status: 'started'; jobId: string; pane: string; session?: string }
  | { status: 'failed'; jobId: string; reason: string }

export function isRepoHandoff(value: unknown): value is RepoHandoff {
  const repo = value as Partial<RepoHandoff> | null
  return (
    typeof repo?.id === 'string' &&
    REPO_ID.test(repo.id) &&
    typeof repo.name === 'string' &&
    REPO_NAME.test(repo.name) &&
    typeof repo.head === 'string' &&
    COMMIT.test(repo.head)
  )
}

export function repoSlug(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 40)
  return slug || 'repo'
}

export function jobRef(jobId: string): string {
  return `refs/ostia/jobs/${jobId}`
}

export function jobBranch(jobId: string): string {
  return `ostia/${jobId}`
}

export function fetchedRef(host: string, jobId: string): string {
  return `refs/remotes/ostia/${host}/${jobId}`
}

export function mirrorPath(repoId: string): string {
  return `.ostia/node/repos/${repoId}.git`
}

export function repoIdOf(name: string, rootCommit: string): string {
  return `${name}-${rootCommit.slice(0, 12)}`
}
