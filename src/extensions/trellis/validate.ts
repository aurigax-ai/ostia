import { KEY_RE, SLUG_RE } from './trellis'

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]

const TITLE_MAX = 300
const TEXT_MAX = 64 * 1024
const NAME_MAX = 100
const ENTRY_SLUG_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/

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
