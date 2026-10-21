import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { isRecordId } from './hookEvent'

export const REMEMBER_TEXT_MAX = 200
export const REMEMBER_OPEN_MAX = 200
export const REMEMBER_DAYS = 14
export const REMEMBER_VERSION = 1
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/
const AGENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const REMEMBER_STATES = ['open', 'done', 'archived'] as const
export type RememberState = (typeof REMEMBER_STATES)[number]

export interface RememberItem {
  v: typeof REMEMBER_VERSION
  id: string
  t: number
  pane: string
  session: string
  agent: string
  text: string
  state: RememberState
  doneAt?: number
  archivedAt?: number
  restoredAt?: number
}

export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()
}

export function parseRememberItem(raw: unknown): RememberItem | null {
  if (!isRecord(raw) || raw.v !== REMEMBER_VERSION) return null
  const { id, t, pane, session, agent, text, state, doneAt, archivedAt, restoredAt } = raw
  if (!isRecordId(id) || typeof t !== 'number' || !Number.isFinite(t)) return null
  if (typeof pane !== 'string' || pane === '') return null
  if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) return null
  if (typeof agent !== 'string' || !AGENT_PATTERN.test(agent)) return null
  if (typeof text !== 'string') return null
  const clean = oneLine(text)
  if (clean === '' || [...clean].length > REMEMBER_TEXT_MAX) return null
  if (!REMEMBER_STATES.includes(state as RememberState)) return null
  const item: RememberItem = {
    v: REMEMBER_VERSION,
    id,
    t,
    pane,
    session,
    agent,
    text: clean,
    state: state as RememberState,
  }
  for (const [key, value] of [
    ['doneAt', doneAt],
    ['archivedAt', archivedAt],
    ['restoredAt', restoredAt],
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    item[key] = value
  }
  return item
}

export function startOf(item: RememberItem): number {
  return Math.max(item.t, item.restoredAt ?? 0)
}

export function isExpired(item: RememberItem, now: number, days: number): boolean {
  return now - startOf(item) >= days * 86_400_000
}
