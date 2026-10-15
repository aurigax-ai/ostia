import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
export const TRELLIS_IDENTITY = 'ostia'

export const HUMAN_ACTOR = `human:${TRELLIS_IDENTITY}`

export interface TrellisDaemonStatus {
  running: boolean
  url: string | null
}

export interface TrellisError {
  code: string
  message: string
  fix?: string
}

export interface TrellisCard {
  ref: string
  title: string
  column: string
  priority: string
  labels: string[]
  version: number
  updatedAt: number
  claimedBy?: string
  claimUntil?: number
}

export interface BoardColumn {
  name: string
  done: boolean
  cards: TrellisCard[]
}

export interface TrellisBoard {
  project: string
  board: string
  slug: string
  columns: BoardColumn[]
}

export interface BoardInfo {
  name: string
  slug: string
  isDefault: boolean
  cardCount: number
}

export interface ProjectInfo {
  key: string
  name: string
}

export interface CardRelation {
  rel: string
  ref: string
  title: string
  column?: string
  done: boolean
}

export interface CardDetail extends TrellisCard {
  body: string
  createdAt: number
  relations: CardRelation[]
}

export interface CardComment {
  id: string
  actor: string
  body: string
  createdAt: number
}

export interface CardActivity {
  seq: number
  at: number
  actor: string
  action: string
  field?: string
  old?: string
  new?: string
}

export interface CardThread {
  comments: CardComment[]
  activity: CardActivity[]
}

export interface VaultEntrySummary {
  slug: string
  ref: string
  title: string
  template: string
  summary: string
  private: boolean
  tags: string[]
  updatedAt: number
}

export interface VaultEntry extends VaultEntrySummary {
  body: string
  sources: string[]
  version: number
}

export interface TrellisEvent {
  seq: number
  ts: number
  actor: string
  entity: string
  ref: string
  title: string
  action: string
  field?: string
  old?: string
  new?: string
}

export interface TrellisProject {
  project: string
  board?: string
  marker: string
}

export interface CardCounts {
  open: number
  claimed: number
}

export type NeedsUser = { kind: 'review' | 'blocked'; column: string }

export const KEY_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MARKER_FILE = '.trellis'

export function countBoard(board: TrellisBoard, nowMs: number): CardCounts {
  let open = 0
  let claimed = 0
  for (const column of board.columns) {
    if (column.done) continue
    for (const card of column.cards) {
      open += 1
      if (isClaimLive(card, nowMs)) claimed += 1
    }
  }
  return { open, claimed }
}

function isClaimLive(card: TrellisCard, nowMs: number): boolean {
  return Boolean(card.claimedBy) && (card.claimUntil === undefined || card.claimUntil > nowMs)
}

export function projectOfRef(ref: string): string | null {
  const address = /^\/([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\//.exec(ref)
  if (address) return address[1] === 'GLOBAL' ? null : address[1]
  const m = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?)-\d+$/.exec(ref)
  return m ? m[1] : null
}

const REVIEW_COLUMN = /review|needs?[-_ ]?(you|user|human|input)|waiting|approv/i
const BLOCKED_COLUMN = /block/i

export interface NotifyKinds {
  review: boolean
  blocked: boolean
}

export const ALL_NOTIFY_KINDS: NotifyKinds = { review: true, blocked: true }

export function needsUser(
  ev: TrellisEvent,
  kinds: NotifyKinds = ALL_NOTIFY_KINDS,
): NeedsUser | null {
  if (ev.entity !== 'card' || ev.action !== 'moved' || ev.field !== 'column') return null
  if (!ev.actor.startsWith('agent:')) return null
  const column = ev.new ?? ''
  if (BLOCKED_COLUMN.test(column)) return kinds.blocked ? { kind: 'blocked', column } : null
  if (REVIEW_COLUMN.test(column)) return kinds.review ? { kind: 'review', column } : null
  return null
}

export function parseMarker(text: string): { project: string; board?: string } | null {
  const s = text.trim()
  if (!s.startsWith('/') || /[\r\n]/.test(s)) return null
  const segs = s.slice(1).split('/')
  const project = segs[0].toUpperCase()
  if (!KEY_RE.test(project) || project === 'GLOBAL') return null
  if (segs.length === 1) return { project }
  if (segs.length === 3 && segs[1] === 'boards' && SLUG_RE.test(segs[2])) {
    return { project, board: segs[2] }
  }
  return null
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export function findProject(workDir: string, home: string): TrellisProject | null {
  let start: string
  try {
    start = realpathSync(resolve(workDir))
    if (!statSync(start).isDirectory()) return null
  } catch {
    return null
  }
  let homeReal = resolve(home)
  try {
    homeReal = realpathSync(homeReal)
  } catch {}
  for (let dir = start; ; ) {
    const parent = dirname(dir)
    if (dir === homeReal || parent === dir) return null
    const marker = join(dir, MARKER_FILE)
    try {
      if (statSync(marker).isFile()) {
        const parsed = parseMarker(readFileSync(marker, 'utf8'))
        return parsed ? { ...parsed, marker } : null
      }
    } catch {}
    if (exists(join(dir, '.git'))) return null
    dir = parent
  }
}
