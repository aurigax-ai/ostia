import type {
  BranchInfo,
  BranchRef,
  ChangeArea,
  GitFailure,
  GitGraphData,
  GraphCommit,
} from '@shared/boards/git'
import { type RelativeStep, formatRelative } from '@shared/common/relativeTime'
import type { TreeNode } from './gitFileTree'
import { type GraphEdge, type GraphNode, type GraphRow, layoutGraph } from './gitGraph'

export const AREA_ORDER: ChangeArea[] = ['conflicted', 'staged', 'unstaged', 'untracked']
export const WORKTREE = 'worktree'
export const ROW_HEIGHT = 24
export const LANE_WIDTH = 14
export const GRAPH_PAD = 8
export const MAX_DRAWN_LANES = 12
export const OVERSCAN = 8
export const GRAPH_PAGE = 300
export const LOAD_MORE_MARGIN = 40
export const LANE_COLORS = 8
export const FALLBACK_VISIBLE_ROWS = 20

const RELATIVE_STEPS: RelativeStep[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]

export function relativeTime(seconds: number, nowMs: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return formatRelative(seconds - nowMs / 1000, RELATIVE_STEPS, format)
}

export function absoluteTime(seconds: number, locale: string): string {
  return new Date(seconds * 1000).toLocaleString(locale)
}

export function failureText(failure: GitFailure): string {
  return failure.message ?? failure.error
}

export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0
    ? { name: path, dir: '' }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

export function leaves<T>(node: TreeNode<T>): T[] {
  return node.kind === 'file' ? [node.item] : node.children.flatMap(leaves)
}

export function rowIndent(depth: number): number {
  return 10 + depth * 12
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function branchLabel(branch: BranchInfo, detached: string): string {
  return branch.head ?? `${branch.oid ? shortSha(branch.oid) : ''} (${detached})`
}

export type GraphEntry = { kind: 'worktree' } | { kind: 'commit'; commit: GraphCommit }

export interface GraphModel {
  entries: GraphEntry[]
  rows: GraphRow[]
  width: number
}

export function entryKey(entry: GraphEntry): string {
  return entry.kind === 'worktree' ? WORKTREE : entry.commit.sha
}

export function buildGraphModel(data: GitGraphData): GraphModel {
  const entries: GraphEntry[] = [
    ...(data.changes.length > 0 ? [{ kind: 'worktree' } as GraphEntry] : []),
    ...data.commits.map((commit): GraphEntry => ({ kind: 'commit', commit })),
  ]
  const head = data.branch.oid
  const nodes: GraphNode[] = entries.map((entry) =>
    entry.kind === 'worktree'
      ? { sha: WORKTREE, parents: head && data.includesHead ? [head] : [], pending: true }
      : { sha: entry.commit.sha, parents: entry.commit.parents },
  )
  const rows = layoutGraph(nodes)
  const lanes = Math.min(MAX_DRAWN_LANES, Math.max(1, ...rows.map((r) => r.width)))
  return { entries, rows, width: GRAPH_PAD * 2 + lanes * LANE_WIDTH }
}

export function indexOfKey(model: GraphModel, key: string | null): number {
  return key === null ? -1 : model.entries.findIndex((e) => entryKey(e) === key)
}

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
}

export function edgePath(edge: GraphEdge, y1: number, y2: number): string {
  const x1 = laneX(edge.from)
  const x2 = laneX(edge.to)
  return x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
}

export function visibleRange(
  scrollTop: number,
  viewport: number,
  count: number,
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visible = Math.ceil((viewport || ROW_HEIGHT * FALLBACK_VISIBLE_ROWS) / ROW_HEIGHT)
  return { first: Math.min(first, count), last: Math.min(count, first + visible + OVERSCAN * 2) }
}

export const SELECTION_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']

export function selectionTarget(key: string, at: number, count: number, viewport: number): number {
  const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1)
  const moves: Record<string, number> = {
    ArrowDown: at + 1,
    ArrowUp: at - 1,
    PageDown: at + page,
    PageUp: at - page,
    Home: 0,
    End: count - 1,
  }
  return Math.min(count - 1, Math.max(0, moves[key] ?? at))
}

export function scrollTopToShow(index: number, scrollTop: number, viewport: number): number {
  const top = index * ROW_HEIGHT
  if (top < scrollTop) return top
  if (top + ROW_HEIGHT > scrollTop + viewport) return top + ROW_HEIGHT - viewport
  return scrollTop
}

export function matchingBranches(branches: BranchRef[], query: string): BranchRef[] {
  const q = query.trim().toLowerCase()
  return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches
}

export function toggledRefs(chosen: string[], ref: string): string[] {
  return chosen.includes(ref) ? chosen.filter((r) => r !== ref) : [...chosen, ref]
}
