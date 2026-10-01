export const CHAT_EDITS_MAX = 32

export interface ChatEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

export type ChatEditError = 'no-match' | 'ambiguous' | 'no-change'

export type ChatEditResult =
  | { ok: true; text: string }
  | { ok: false; error: ChatEditError; edit: number; count?: number }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function editOf(raw: unknown): ChatEdit | null {
  if (!isRecord(raw)) return null
  const oldText = raw.old_text ?? raw.oldText
  const newText = raw.new_text ?? raw.newText
  if (typeof oldText !== 'string' || oldText === '' || typeof newText !== 'string') return null
  const all = raw.replace_all ?? raw.replaceAll
  return all === true ? { oldText, newText, replaceAll: true } : { oldText, newText }
}

export function parseEdits(input: unknown): ChatEdit[] | null {
  if (!isRecord(input)) return null
  const list = Array.isArray(input.edits) ? input.edits : [input]
  if (list.length === 0 || list.length > CHAT_EDITS_MAX) return null
  const edits = list.map(editOf)
  return edits.every((e): e is ChatEdit => e !== null) ? edits : null
}

function count(text: string, needle: string): number {
  let found = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    found += 1
  }
  return found
}

function crlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n')
}

function withFileLineEndings(text: string, edit: ChatEdit): ChatEdit {
  if (!text.includes('\r\n')) return edit
  const oldText =
    edit.oldText.includes('\r') || text.includes(edit.oldText) ? edit.oldText : crlf(edit.oldText)
  const newText = edit.newText.includes('\r') ? edit.newText : crlf(edit.newText)
  return { ...edit, oldText, newText }
}

export function applyEdits(text: string, edits: readonly ChatEdit[]): ChatEditResult {
  let current = text
  for (let index = 0; index < edits.length; index++) {
    const edit = withFileLineEndings(current, edits[index])
    const found = count(current, edit.oldText)
    if (found === 0) return { ok: false, error: 'no-match', edit: index }
    if (found > 1 && !edit.replaceAll) {
      return { ok: false, error: 'ambiguous', edit: index, count: found }
    }
    current = edit.replaceAll
      ? current.split(edit.oldText).join(edit.newText)
      : current.replace(edit.oldText, () => edit.newText)
  }
  return current === text ? { ok: false, error: 'no-change', edit: 0 } : { ok: true, text: current }
}
