export type LineEditOp =
  | 'home'
  | 'end'
  | 'charBack'
  | 'charForward'
  | 'wordBack'
  | 'wordForward'
  | 'killEnd'
  | 'killStart'
  | 'killWordBack'
  | 'killWordForward'
  | 'deleteChar'
  | 'backspace'
  | 'yank'
  | 'historyPrev'
  | 'historyNext'
  | 'clearScreen'

export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export interface LineBuffer {
  text: string
  caret: number
}

export interface LineEditResult extends LineBuffer {
  killed: string | null
}

const CTRL_OPS: Record<string, LineEditOp> = {
  a: 'home',
  e: 'end',
  b: 'charBack',
  f: 'charForward',
  k: 'killEnd',
  u: 'killStart',
  w: 'killWordBack',
  d: 'deleteChar',
  h: 'backspace',
  y: 'yank',
  p: 'historyPrev',
  n: 'historyNext',
  l: 'clearScreen',
}

const ALT_OPS: Record<string, LineEditOp> = {
  b: 'wordBack',
  f: 'wordForward',
  d: 'killWordForward',
}

const NATIVE_CTRL_KEYS = new Set(['c', 'v', 'x', 'z'])

function letterOf(e: KeyLike): string | null {
  if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase()
  return e.key.length === 1 ? e.key.toLowerCase() : null
}

export function lineEditOp(e: KeyLike): LineEditOp | null {
  if (e.metaKey || e.shiftKey) return null
  const letter = letterOf(e)
  if (!letter) return null
  if (e.ctrlKey && !e.altKey) return CTRL_OPS[letter] ?? null
  if (e.altKey && !e.ctrlKey) return ALT_OPS[letter] ?? null
  return null
}

export function shellKeyBytes(e: KeyLike): string | null {
  if (e.metaKey || e.shiftKey) return null
  if (e.ctrlKey && !e.altKey) {
    const letter = letterOf(e)
    if (!letter || !/^[a-z]$/.test(letter) || NATIVE_CTRL_KEYS.has(letter)) return null
    return String.fromCharCode(letter.charCodeAt(0) - 96)
  }
  if (e.altKey && !e.ctrlKey) {
    const letter = letterOf(e)
    if (letter && /^[a-z]$/.test(letter)) return `\x1b${letter}`
    if (e.key.length === 1 && /^[!-~]$/.test(e.key)) return `\x1b${e.key}`
  }
  return null
}

function lineStart(text: string, caret: number): number {
  return text.lastIndexOf('\n', caret - 1) + 1
}

function lineEnd(text: string, caret: number): number {
  const at = text.indexOf('\n', caret)
  return at === -1 ? text.length : at
}

const isWordChar = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c)

function wordBackFrom(text: string, caret: number): number {
  let i = caret
  while (i > 0 && !isWordChar(text[i - 1])) i--
  while (i > 0 && isWordChar(text[i - 1])) i--
  return i
}

function wordForwardFrom(text: string, caret: number): number {
  let i = caret
  while (i < text.length && !isWordChar(text[i])) i++
  while (i < text.length && isWordChar(text[i])) i++
  return i
}

function spaceWordBackFrom(text: string, caret: number): number {
  let i = caret
  while (i > 0 && /\s/.test(text[i - 1])) i--
  while (i > 0 && !/\s/.test(text[i - 1])) i--
  return i
}

function cut(buf: LineBuffer, from: number, to: number, caret: number): LineEditResult {
  if (from === to) return { ...buf, killed: null }
  return {
    text: buf.text.slice(0, from) + buf.text.slice(to),
    caret,
    killed: buf.text.slice(from, to),
  }
}

function move(buf: LineBuffer, caret: number): LineEditResult {
  return { text: buf.text, caret, killed: null }
}

export function applyLineEdit(op: LineEditOp, buf: LineBuffer, yank: string): LineEditResult {
  const { text, caret } = buf
  switch (op) {
    case 'home':
      return move(buf, lineStart(text, caret))
    case 'end':
      return move(buf, lineEnd(text, caret))
    case 'charBack':
      return move(buf, Math.max(0, caret - 1))
    case 'charForward':
      return move(buf, Math.min(text.length, caret + 1))
    case 'wordBack':
      return move(buf, wordBackFrom(text, caret))
    case 'wordForward':
      return move(buf, wordForwardFrom(text, caret))
    case 'killEnd': {
      const end = lineEnd(text, caret)
      return cut(buf, caret, end === caret && end < text.length ? end + 1 : end, caret)
    }
    case 'killStart': {
      const start = lineStart(text, caret)
      return cut(buf, start, caret, start)
    }
    case 'killWordBack': {
      const start = spaceWordBackFrom(text, caret)
      return cut(buf, start, caret, start)
    }
    case 'killWordForward':
      return cut(buf, caret, wordForwardFrom(text, caret), caret)
    case 'deleteChar':
      return { text: text.slice(0, caret) + text.slice(caret + 1), caret, killed: null }
    case 'backspace':
      if (caret === 0) return move(buf, 0)
      return { text: text.slice(0, caret - 1) + text.slice(caret), caret: caret - 1, killed: null }
    case 'yank':
      if (!yank) return move(buf, caret)
      return {
        text: text.slice(0, caret) + yank + text.slice(caret),
        caret: caret + yank.length,
        killed: null,
      }
    default:
      return move(buf, caret)
  }
}
