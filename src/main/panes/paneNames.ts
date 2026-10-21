import { hasControlCharacter, isHiddenFormat } from '../../shared/common/hiddenText'
import { SHORT_ID_LENGTH } from '../../shared/panes/paneStatus'

const NAME_MAX = 40
const DESC_MAX = 200

const SLUG = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const ID_LIKE = /^[0-9a-f-]+$/

export interface PaneName {
  name: string
  desc?: string
}

export type Claim =
  | { ok: true; held: PaneName }
  | { ok: false; error: 'name-taken'; name: string; holder: string }
  | { ok: false; error: 'bad-name' | 'bad-desc'; message: string }

const held = new Map<string, PaneName>()
const holders = new Map<string, Set<string>>()
const sessions = new Map<string, string>()

export function parseName(raw: unknown): { name: string } | { message: string } {
  if (typeof raw !== 'string') return { message: 'name must be text' }
  if (raw.length === 0 || raw.length > NAME_MAX || !SLUG.test(raw)) {
    return {
      message: `name is 1-${NAME_MAX} lowercase letters, digits, '-' or '.', starting and ending with a letter or digit`,
    }
  }
  if (raw.length >= SHORT_ID_LENGTH && ID_LIKE.test(raw)) {
    return { message: 'name looks like a pane id; add a letter that is not a hex digit' }
  }
  return { name: raw }
}

export function parseDesc(raw: unknown): { desc: string | undefined } | { message: string } {
  if (raw === undefined) return { desc: undefined }
  if (typeof raw !== 'string') return { message: 'description must be text' }
  const desc = raw.trim()
  if (desc.length > DESC_MAX) return { message: `description is at most ${DESC_MAX} characters` }
  const hidden = Array.from(desc).some((ch) => isHiddenFormat(ch.charCodeAt(0)))
  if (hasControlCharacter(desc) || hidden) {
    return { message: 'description is one line without control or format characters' }
  }
  return { desc: desc || undefined }
}

export function claimName(
  paneId: string,
  rawName: unknown,
  rawDesc: unknown,
  reaches: (holderPaneId: string) => boolean,
): Claim {
  const name = parseName(rawName)
  if ('message' in name) return { ok: false, error: 'bad-name', message: name.message }
  const desc = parseDesc(rawDesc)
  if ('message' in desc) return { ok: false, error: 'bad-desc', message: desc.message }
  const rival = [...(holders.get(name.name) ?? [])].find((id) => id !== paneId && reaches(id))
  if (rival !== undefined) return { ok: false, error: 'name-taken', name: name.name, holder: rival }
  release(paneId)
  const entry: PaneName = { name: name.name, ...(desc.desc ? { desc: desc.desc } : {}) }
  held.set(paneId, entry)
  holders.set(entry.name, new Set([...(holders.get(entry.name) ?? []), paneId]))
  return { ok: true, held: entry }
}

export function nameOf(paneId: string): PaneName | undefined {
  return held.get(paneId)
}

export function panesNamed(name: string): string[] {
  return [...(holders.get(name) ?? [])]
}

function release(paneId: string): boolean {
  const entry = held.get(paneId)
  if (!entry) return false
  held.delete(paneId)
  const rest = holders.get(entry.name)
  rest?.delete(paneId)
  if (rest?.size === 0) holders.delete(entry.name)
  return true
}

export function dropName(paneId: string): boolean {
  sessions.delete(paneId)
  return release(paneId)
}

export function dropNamesWhere(drop: (paneId: string) => boolean): void {
  for (const paneId of [...held.keys()]) if (drop(paneId)) dropName(paneId)
}

export function noteAgentSession(paneId: string, agent: string, sessionId: string): void {
  const session = `${agent}:${sessionId}`
  const before = sessions.get(paneId)
  if (before !== undefined && before !== session) release(paneId)
  sessions.set(paneId, session)
}

export function forgetNames(): void {
  held.clear()
  holders.clear()
  sessions.clear()
}
