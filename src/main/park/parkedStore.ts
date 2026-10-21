import { randomBytes } from 'node:crypto'
import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import { PARK_SUMMARY_MAX, PARKED_PER_WORKSPACE_MAX, singleLine } from '../../shared/park/park'
import { loadJson, saveJson } from '../platform/jsonStore'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_PATTERN = /^[a-z2-7]{10}$/
const TITLE_MAX = 200
const WORKSPACE_ID_MAX = 200
const FORMAT = 1

export interface ParkedRecord {
  id: string
  workspaceId: string
  resume: AgentResume
  title: string
  titlePinned?: true
  summary?: string
  parkedAt: number
}

export interface ParkInput {
  workspaceId: string
  resume: AgentResume
  title: string
  titlePinned?: true
  summary?: string
}

export type ParkResult =
  | { ok: true; record: ParkedRecord; updated: boolean }
  | { ok: false; reason: 'too-many' | 'invalid' }

function newId(): string {
  return [...randomBytes(10)].map((byte) => BASE32[byte % 32]).join('')
}

function withoutTyped(resume: AgentResume): AgentResume | null {
  return parseAgentResume(resume)
}

function optionalLine(raw: unknown, max: number): string | undefined | null {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return null
  const line = singleLine(raw, max)
  return line === '' ? undefined : line
}

function parseRecord(raw: unknown): ParkedRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, workspaceId, resume, title, titlePinned, summary, parkedAt } = raw as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null
  if (
    typeof workspaceId !== 'string' ||
    workspaceId === '' ||
    workspaceId.length > WORKSPACE_ID_MAX
  )
    return null
  const parsed = parseAgentResume(resume)
  if (!parsed) return null
  if (typeof title !== 'string' || title === '') return null
  if (typeof parkedAt !== 'number' || !Number.isFinite(parkedAt)) return null
  const summaryLine = optionalLine(summary, PARK_SUMMARY_MAX)
  if (summaryLine === null) return null
  return {
    id,
    workspaceId,
    resume: parsed,
    title: singleLine(title, TITLE_MAX),
    ...(titlePinned === true ? { titlePinned: true as const } : {}),
    ...(summaryLine ? { summary: summaryLine } : {}),
    parkedAt,
  }
}

function sameSession(record: ParkedRecord, input: ParkInput): boolean {
  return (
    record.workspaceId === input.workspaceId &&
    record.resume.agent === input.resume.agent &&
    record.resume.id === input.resume.id
  )
}

export class ParkedStore {
  private items: ParkedRecord[]
  private readonly listeners = new Set<(workspaceId: string) => void>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    const stored = loadJson<{ v?: unknown; items?: unknown }>(file, {})
    const raw = stored.v === FORMAT && Array.isArray(stored.items) ? stored.items : []
    this.items = raw.flatMap((entry) => {
      const record = parseRecord(entry)
      return record ? [record] : []
    })
  }

  subscribe(listener: (workspaceId: string) => void): void {
    this.listeners.add(listener)
  }

  list(workspaceId: string): ParkedRecord[] {
    return this.items
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => b.parkedAt - a.parkedAt)
  }

  count(workspaceId: string): number {
    return this.items.filter((item) => item.workspaceId === workspaceId).length
  }

  get(id: string): ParkedRecord | undefined {
    return this.items.find((item) => item.id === id)
  }

  park(input: ParkInput): ParkResult {
    const resume = withoutTyped(input.resume)
    const title = singleLine(input.title, TITLE_MAX)
    if (!resume || title === '' || input.workspaceId === '') return { ok: false, reason: 'invalid' }
    const summary = optionalLine(input.summary, PARK_SUMMARY_MAX)
    const known = this.items.find((item) => sameSession(item, { ...input, resume }))
    if (!known && this.count(input.workspaceId) >= PARKED_PER_WORKSPACE_MAX) {
      return { ok: false, reason: 'too-many' }
    }
    const record: ParkedRecord = {
      id: known?.id ?? newId(),
      workspaceId: input.workspaceId,
      resume,
      title,
      ...(input.titlePinned ? { titlePinned: true as const } : {}),
      ...(summary ? { summary } : {}),
      parkedAt: this.now(),
    }
    this.items = known
      ? this.items.map((item) => (item.id === known.id ? record : item))
      : [...this.items, record]
    this.save()
    this.emit(record.workspaceId)
    return { ok: true, record, updated: known !== undefined }
  }

  remove(id: string): boolean {
    const known = this.get(id)
    if (!known) return false
    this.items = this.items.filter((item) => item.id !== id)
    this.save()
    this.emit(known.workspaceId)
    return true
  }

  settle(workspaceId: string, agent: string, sessionId: string): number {
    const gone = this.items.filter(
      (item) =>
        item.workspaceId === workspaceId &&
        item.resume.agent === agent &&
        item.resume.id === sessionId,
    )
    if (gone.length === 0) return 0
    this.items = this.items.filter((item) => !gone.includes(item))
    this.save()
    this.emit(workspaceId)
    return gone.length
  }

  private emit(workspaceId: string): void {
    for (const listener of [...this.listeners]) listener(workspaceId)
  }

  private save(): void {
    saveJson(this.file, { v: FORMAT, items: this.items }, { secure: true })
  }
}
