import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface TrellisUiInfo {
  url: string
  started: boolean
}

export interface TrellisDaemonStatus {
  running: boolean
  url: string | null
}

export interface TrellisCard {
  ref: string
  title: string
  column: string
  claimedBy?: string
  claimUntil?: number
}

export interface TrellisColumn {
  name: string
  isDone: boolean
}

export interface TrellisError {
  code: string
  message: string
  fix?: string
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

const KEY_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MARKER_FILE = '.trellis'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function parseObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  let value = parseJson(trimmed)
  if (value === undefined) value = parseJson(trimmed.split('\n')[0] ?? '')
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function loopbackHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:') return null
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    return url
  } catch {
    return null
  }
}

export function parseUiInfo(stdout: string): TrellisUiInfo | null {
  const obj = parseObject(stdout)
  const url = obj ? loopbackHttpUrl(obj.url) : null
  if (!obj || !url) return null
  return { url: url.href, started: obj.started === true }
}

export function parseDaemonStatus(stdout: string): TrellisDaemonStatus | null {
  const obj = parseObject(stdout)
  if (!obj || typeof obj.running !== 'boolean') return null
  const url = loopbackHttpUrl(obj.url)
  return { running: obj.running, url: url ? url.href : null }
}

export function parseError(stdout: string): TrellisError | null {
  const obj = parseObject(stdout)
  const err = obj?.error
  if (typeof err !== 'object' || err === null) return null
  const e = err as Record<string, unknown>
  const code = str(e.code)
  const message = str(e.message)
  if (!code || !message) return null
  const fix = str(e.fix)
  return fix ? { code, message, fix } : { code, message }
}

export function parseCards(stdout: string): TrellisCard[] | null {
  const obj = parseObject(stdout)
  if (!obj || !Array.isArray(obj.cards)) return null
  const cards: TrellisCard[] = []
  for (const raw of obj.cards) {
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    const ref = str(c.ref)
    const column = str(c.column)
    if (!ref || !column) continue
    const card: TrellisCard = { ref, title: str(c.title) ?? '', column }
    const claimedBy = str(c.claimed_by)
    if (claimedBy) card.claimedBy = claimedBy
    const claimUntil = num(c.claim_until)
    if (claimUntil !== undefined) card.claimUntil = claimUntil
    cards.push(card)
  }
  return cards
}

export function parseColumns(stdout: string): TrellisColumn[] | null {
  const obj = parseObject(stdout)
  if (!obj || !Array.isArray(obj.columns)) return null
  const columns: TrellisColumn[] = []
  for (const raw of obj.columns) {
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    const name = str(c.name)
    if (name) columns.push({ name, isDone: c.is_done === true })
  }
  return columns
}

export function countCards(
  cards: TrellisCard[],
  columns: TrellisColumn[],
  nowMs: number,
): CardCounts {
  const done = new Set(columns.filter((c) => c.isDone).map((c) => c.name))
  let open = 0
  let claimed = 0
  for (const card of cards) {
    if (done.has(card.column)) continue
    open += 1
    if (card.claimedBy && (card.claimUntil === undefined || card.claimUntil > nowMs)) claimed += 1
  }
  return { open, claimed }
}

export function parseEventLine(line: string): TrellisEvent | { gap: true } | null {
  const obj = parseObject(line)
  if (!obj) return null
  if (obj.gap === true) return { gap: true }
  const seq = num(obj.seq)
  const action = str(obj.action)
  const entity = str(obj.entity)
  if (seq === undefined || !action || !entity) return null
  const ev: TrellisEvent = {
    seq,
    ts: num(obj.ts) ?? 0,
    actor: str(obj.actor) ?? '',
    entity,
    ref: str(obj.ref) ?? '',
    title: str(obj.title) ?? '',
    action,
  }
  const field = str(obj.field)
  if (field) ev.field = field
  const oldValue = str(obj.old)
  if (oldValue !== undefined) ev.old = oldValue
  const newValue = str(obj.new)
  if (newValue !== undefined) ev.new = newValue
  return ev
}

export function projectOfRef(ref: string): string | null {
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

export function projectPath(project: TrellisProject | null): string {
  if (!project) return '/'
  const base = `/p/${encodeURIComponent(project.project)}`
  return project.board ? `${base}/b/${encodeURIComponent(project.board)}` : base
}

export function cardRef(raw: string): string | null {
  const ref = raw.trim().toUpperCase()
  return projectOfRef(ref) ? ref : null
}

export function cardPath(ref: string): string | null {
  const valid = cardRef(ref)
  const project = valid ? projectOfRef(valid) : null
  return valid && project ? `/p/${project}/card/${valid}` : null
}

export function isAppPath(path: string): boolean {
  return (
    path === '/' ||
    /^\/p\/[A-Z][A-Z0-9-]*(\/b\/[a-z0-9-]+)?$/.test(path) ||
    /^\/p\/[A-Z][A-Z0-9-]*\/card\/[A-Z][A-Z0-9-]*-\d+$/.test(path)
  )
}
