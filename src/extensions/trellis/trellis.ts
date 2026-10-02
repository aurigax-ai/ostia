import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/pine-extension-sdk'

export const HUMAN_ACTOR = `human:${PRODUCT_NAME}`

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

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]

export const TITLE_MAX = 300
export const TEXT_MAX = 64 * 1024
const NAME_MAX = 100

const KEY_RE = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const ENTRY_SLUG_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/
const MARKER_FILE = '.trellis'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function parseObjectOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  let value = parseJson(trimmed)
  if (value === undefined) value = parseJson(trimmed.split('\n')[0] ?? '')
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

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

export function parseDaemonStatus(stdout: string): TrellisDaemonStatus | null {
  const obj = parseObjectOutput(stdout)
  if (!obj || typeof obj.running !== 'boolean') return null
  const url = loopbackHttpUrl(obj.url)
  return { running: obj.running, url: url ? url.href : null }
}

export function parseError(output: string): TrellisError | null {
  const obj = parseObjectOutput(output)
  const err = obj?.error
  if (!isRecord(err)) return null
  const code = str(err.code)
  const message = str(err.message)
  if (!code || !message) return null
  const fix = str(err.fix)
  return fix ? { code, message, fix } : { code, message }
}

function readCard(c: Record<string, unknown>): TrellisCard | null {
  const ref = str(c.ref)
  const column = str(c.column)
  if (!ref || !column) return null
  const card: TrellisCard = {
    ref,
    title: str(c.title) ?? '',
    column,
    priority: str(c.priority) ?? 'normal',
    labels: strings(c.labels),
    version: num(c.version) ?? 0,
    updatedAt: num(c.updated_at) ?? 0,
  }
  const claimedBy = str(c.claimed_by)
  if (claimedBy) card.claimedBy = claimedBy
  const claimUntil = num(c.claim_until)
  if (claimUntil !== undefined) card.claimUntil = claimUntil
  return card
}

export function parseCard(stdout: string): TrellisCard | null {
  const obj = parseObjectOutput(stdout)
  return obj ? readCard(obj) : null
}

export function parseBoard(stdout: string): TrellisBoard | null {
  const obj = parseObjectOutput(stdout)
  const project = str(obj?.project)
  if (!obj || !project || !Array.isArray(obj.columns)) return null
  const columns: BoardColumn[] = []
  for (const c of records(obj.columns)) {
    const name = str(c.name)
    if (!name) continue
    const cards = records(c.cards)
      .map(readCard)
      .filter((card): card is TrellisCard => card !== null)
    columns.push({ name, done: c.done === true, cards })
  }
  return {
    project,
    board: str(obj.board) ?? '',
    slug: str(obj.slug) ?? '',
    columns,
  }
}

export function parseBoards(stdout: string): BoardInfo[] | null {
  const obj = parseObjectOutput(stdout)
  if (!obj || !Array.isArray(obj.boards)) return null
  return records(obj.boards).flatMap((b) => {
    const slug = str(b.slug)
    if (!slug) return []
    return [
      {
        name: str(b.name) ?? slug,
        slug,
        isDefault: b.is_default === true,
        cardCount: num(b.card_count) ?? 0,
      },
    ]
  })
}

export function parseProjects(stdout: string): ProjectInfo[] | null {
  const obj = parseObjectOutput(stdout)
  if (!obj || !Array.isArray(obj.projects)) return null
  return records(obj.projects).flatMap((p) => {
    const key = str(p.key)
    return key && KEY_RE.test(key) ? [{ key, name: str(p.name) ?? key }] : []
  })
}

function readRelation(r: Record<string, unknown>): CardRelation | null {
  const rel = str(r.rel)
  const ref = str(r.ref)
  if (!rel || !ref) return null
  const relation: CardRelation = { rel, ref, title: str(r.title) ?? '', done: r.done === true }
  const column = str(r.column)
  if (column) relation.column = column
  return relation
}

export function parseCardDetail(stdout: string): CardDetail | null {
  const obj = parseObjectOutput(stdout)
  const card = obj ? readCard(obj) : null
  if (!obj || !card) return null
  return {
    ...card,
    body: str(obj.body) ?? '',
    createdAt: num(obj.created_at) ?? 0,
    relations: records(obj.relations)
      .map(readRelation)
      .filter((r): r is CardRelation => r !== null),
  }
}

export function parseCardThread(text: string): CardThread | null {
  const obj = parseObjectOutput(text)
  if (!obj || !Array.isArray(obj.comments)) return null
  const comments = records(obj.comments).flatMap((c) => {
    const body = str(c.body)
    if (body === undefined) return []
    return [
      {
        id: str(c.id) ?? '',
        actor: str(c.actor) ?? '',
        body,
        createdAt: num(c.created_at) ?? 0,
      },
    ]
  })
  const activity = records(obj.events).flatMap((e) => {
    const seq = num(e.seq)
    const action = str(e.action)
    if (seq === undefined || !action) return []
    const item: CardActivity = {
      seq,
      at: num(e.timestamp) ?? 0,
      actor: str(e.actor) ?? '',
      action,
    }
    const field = str(e.field)
    if (field) item.field = field
    const oldValue = str(e.old_value)
    if (oldValue !== undefined) item.old = oldValue
    const newValue = str(e.new_value)
    if (newValue !== undefined) item.new = newValue
    return [item]
  })
  return { comments, activity }
}

function readEntrySummary(e: Record<string, unknown>): VaultEntrySummary | null {
  const slug = str(e.slug)
  if (!slug) return null
  return {
    slug,
    ref: str(e.ref) ?? '',
    title: str(e.title) ?? slug,
    template: str(e.template) ?? '',
    summary: str(e.summary) ?? '',
    private: e.private === true,
    tags: strings(e.tags),
    updatedAt: num(e.updated_at) ?? 0,
  }
}

export function parseVaultList(stdout: string): VaultEntrySummary[] | null {
  const obj = parseObjectOutput(stdout)
  if (!obj || !Array.isArray(obj.entries)) return null
  return records(obj.entries)
    .map(readEntrySummary)
    .filter((e): e is VaultEntrySummary => e !== null)
}

export function parseVaultEntry(stdout: string): VaultEntry | null {
  const obj = parseObjectOutput(stdout)
  const summary = obj ? readEntrySummary(obj) : null
  if (!obj || !summary) return null
  return {
    ...summary,
    body: (str(obj.body) ?? '').replace(/^\n/, ''),
    sources: strings(obj.sources),
    version: num(obj.version) ?? 0,
  }
}

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

export function isClaimLive(card: TrellisCard, nowMs: number): boolean {
  return Boolean(card.claimedBy) && (card.claimUntil === undefined || card.claimUntil > nowMs)
}

export function parseEventLine(line: string): TrellisEvent | { gap: true } | null {
  const obj = parseObjectOutput(line)
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

export function cardRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const ref = raw.trim().toUpperCase()
  return /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$/.test(ref) ? ref : null
}

export function projectKey(raw: unknown): string | null {
  return typeof raw === 'string' && KEY_RE.test(raw) && raw !== 'GLOBAL' ? raw : null
}

export function boardSlug(raw: unknown): string | null {
  return typeof raw === 'string' && SLUG_RE.test(raw) && raw.length <= NAME_MAX ? raw : null
}

export function entrySlug(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 200 && ENTRY_SLUG_RE.test(raw) ? raw : null
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function columnName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return name && name.length <= NAME_MAX && !hasControlCharacter(name) ? name : null
}

export function priority(raw: unknown): Priority | null {
  return PRIORITIES.find((p) => p === raw) ?? null
}

export function cardTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const title = raw.replace(/\s+/g, ' ').trim()
  return title && title.length <= TITLE_MAX ? title : null
}

export function longText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\r\n?/g, '\n')
  return text.length <= TEXT_MAX ? text : null
}

export interface PanelTarget {
  view: 'board' | 'vault'
  card?: string
}

export function cardPath(ref: string): string | null {
  const valid = cardRef(ref)
  return valid ? `/card/${valid}` : null
}

export const BOARD_PATH = '/board'
export const VAULT_PATH = '/vault'

export function panelTarget(path: string | undefined): PanelTarget {
  if (!path) return { view: 'board' }
  if (path === VAULT_PATH) return { view: 'vault' }
  const card = /^\/card\/([^/?#]+)$/.exec(path)
  const ref = card ? cardRef(card[1]) : null
  return ref ? { view: 'board', card: ref } : { view: 'board' }
}
