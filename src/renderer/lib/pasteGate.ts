export type PasteSource = 'human' | 'generated'

export interface HumanPastePlan {
  text: string
  confirm: boolean
}

export interface PreviewPart {
  text: string
  control: boolean
  offset: number
}

export interface PastePreview {
  parts: PreviewPart[]
  truncated: boolean
}

const TAB = 9
const LF = 10
const CR = 13
const DEL = 127
const PREVIEW_LIMIT = 20000
const TRAILING_NEWLINE = /\r?\n$/
const LINE_BREAK = /\r\n|\r|\n/

const isNewline = (code: number): boolean => code === LF || code === CR
const isC1 = (code: number): boolean => code >= 0x80 && code <= 0x9f
const isControl = (code: number): boolean =>
  (code < 32 && !isNewline(code) && code !== TAB) || code === DEL || isC1(code)

function hasNewline(text: string): boolean {
  return /[\r\n]/.test(text)
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (isControl(text.charCodeAt(i))) return true
  return false
}

function stripControls(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) if (!isControl(text.charCodeAt(i))) out += text[i]
  return out
}

export function planHumanPaste(text: string, confirmMultiLine: boolean): HumanPastePlan {
  const body = text.replace(TRAILING_NEWLINE, '')
  if (!hasNewline(body)) return { text: stripControls(body), confirm: false }
  if (confirmMultiLine) return { text, confirm: true }
  return { text: stripControls(text), confirm: false }
}

export function confirmsGeneratedText(text: string): boolean {
  return hasNewline(text) || hasControl(text)
}

export function countLines(text: string): number {
  return text.replace(TRAILING_NEWLINE, '').split(LINE_BREAK).length
}

export function controlLabel(code: number): string {
  if (code === DEL) return '^?'
  if (code < 32) return `^${String.fromCharCode(code + 64)}`
  return `\\x${code.toString(16)}`
}

export function pastePreview(text: string): PastePreview {
  const parts: PreviewPart[] = []
  let start = 0
  const end = Math.min(text.length, PREVIEW_LIMIT)
  const flush = (to: number): void => {
    if (to > start) parts.push({ text: text.slice(start, to), control: false, offset: start })
  }
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i)
    if (!isControl(code)) continue
    flush(i)
    parts.push({ text: controlLabel(code), control: true, offset: i })
    start = i + 1
  }
  flush(end)
  return { parts, truncated: text.length > PREVIEW_LIMIT }
}

export function planDraftPaste(text: string): string {
  return planHumanPaste(text, false).text
}
