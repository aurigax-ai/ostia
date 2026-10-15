import {
  type BoardColumn,
  type BoardInfo,
  type CardActivity,
  type CardDetail,
  type CardRelation,
  type CardThread,
  KEY_RE,
  type ProjectInfo,
  type TrellisBoard,
  type TrellisCard,
  type TrellisDaemonStatus,
  type TrellisError,
  type TrellisEvent,
  type VaultEntry,
  type VaultEntrySummary,
} from './trellis'

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
