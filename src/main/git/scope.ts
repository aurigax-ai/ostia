import type { BranchRef, GraphScope, ScopePlan } from '../../shared/boards/git'
import { FIELD_SEP } from './history'

export const CURRENT_SCOPE: GraphScope = { kind: 'current' }
export const MAX_CHOSEN_REFS = 64
const MAX_REF_LENGTH = 256
const LOCAL_PREFIX = 'refs/heads/'
const REMOTE_PREFIX = 'refs/remotes/'

export const BRANCH_REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(committerdate:unix)',
  '%(symref)',
].join(FIELD_SEP)

export function isBranchRef(ref: string): boolean {
  return (
    ref.length <= MAX_REF_LENGTH &&
    (ref.startsWith(LOCAL_PREFIX) || ref.startsWith(REMOTE_PREFIX)) &&
    !/[\s\0]/.test(ref)
  )
}

export function parseScope(raw: unknown): GraphScope | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'current' || kind === 'all') return { kind }
  if (kind !== 'chosen') return null
  const refs = (raw as { refs?: unknown }).refs
  if (!Array.isArray(refs)) return null
  const valid = [
    ...new Set(refs.filter((r): r is string => typeof r === 'string' && isBranchRef(r))),
  ]
  if (valid.length === 0) return null
  return { kind: 'chosen', refs: valid.slice(0, MAX_CHOSEN_REFS) }
}

export function parseBranchRefs(output: string, head: string | null): BranchRef[] {
  const refs: BranchRef[] = []
  for (const line of output.split('\n')) {
    const [ref, sha, time, symref] = line.split(FIELD_SEP)
    if (!ref || !sha || symref || !isBranchRef(ref)) continue
    const remote = ref.startsWith(REMOTE_PREFIX)
    const name = ref.slice(remote ? REMOTE_PREFIX.length : LOCAL_PREFIX.length)
    refs.push({
      ref,
      name,
      remote,
      current: !remote && name === head,
      sha,
      time: Number(time) || 0,
    })
  }
  return refs.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      Number(a.remote) - Number(b.remote) ||
      b.time - a.time ||
      a.name.localeCompare(b.name),
  )
}

export function planScope(scope: GraphScope, branches: BranchRef[]): ScopePlan {
  if (scope.kind === 'all') {
    return { scope, revisions: ['--branches', '--remotes', 'HEAD'], includesHead: true }
  }
  if (scope.kind === 'chosen') {
    const known = new Map(branches.map((b) => [b.ref, b]))
    const refs = scope.refs.filter((r) => known.has(r))
    if (refs.length > 0) {
      return {
        scope: { kind: 'chosen', refs },
        revisions: ['--end-of-options', ...refs],
        includesHead: refs.some((r) => known.get(r)?.current),
      }
    }
  }
  return { scope: CURRENT_SCOPE, revisions: ['HEAD'], includesHead: true }
}

export type { BranchRef, GraphScope, ScopePlan }
