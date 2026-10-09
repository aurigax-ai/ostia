export type VimMode = 'insert' | 'normal'

export type VimMotion = 'h' | 'j' | 'k' | 'l' | 'w' | 'b' | 'e' | '0' | '$'

export type VimInsert = 'i' | 'a' | 'A' | 'I' | 'o' | 'O'

export type VimCommand =
  | { kind: 'move'; motion: VimMotion; count: number }
  | { kind: 'delete' | 'change'; motion: VimMotion | 'line'; count: number }
  | { kind: 'deleteChar'; count: number }
  | { kind: 'insert'; at: VimInsert }
  | { kind: 'undo'; count: number }

export interface VimBuffer {
  text: string
  caret: number
}

export interface VimResult extends VimBuffer {
  mode: VimMode
}

const MOTIONS = new Set<string>(['h', 'j', 'k', 'l', 'w', 'b', 'e', '0', '$'])
const OPERATOR_MOTIONS = new Set<string>(['h', 'l', 'w', 'b', 'e', '0', '$'])
const INSERTS = new Set<string>(['i', 'a', 'A', 'I', 'o', 'O'])
const COUNTED = /^([1-9]\d*)?([\s\S]*)$/

function splitCount(keys: string): { count: number; rest: string } {
  const [, digits, rest] = COUNTED.exec(keys) ?? ['', undefined, keys]
  return { count: digits ? Number(digits) : 1, rest }
}

export function parseVimKeys(keys: string): VimCommand | 'pending' | null {
  const { count, rest } = splitCount(keys)
  if (rest === '') return 'pending'
  const head = rest[0]
  if (head === 'd' || head === 'c') {
    const kind = head === 'd' ? 'delete' : 'change'
    const inner = splitCount(rest.slice(1))
    if (inner.rest === '') return 'pending'
    if (inner.rest.length > 1) return null
    const total = count * inner.count
    if (inner.rest === head) return { kind, motion: 'line', count: total }
    if (!OPERATOR_MOTIONS.has(inner.rest)) return null
    return { kind, motion: inner.rest as VimMotion, count: total }
  }
  if (rest.length > 1) return null
  if (head === 'x') return { kind: 'deleteChar', count }
  if (head === 'u') return { kind: 'undo', count }
  if (head === 'D') return { kind: 'delete', motion: '$', count: 1 }
  if (head === 'C') return { kind: 'change', motion: '$', count: 1 }
  if (INSERTS.has(head)) return { kind: 'insert', at: head as VimInsert }
  if (MOTIONS.has(head)) return { kind: 'move', motion: head as VimMotion, count }
  return null
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1
}

function lineEnd(text: string, pos: number): number {
  const end = text.indexOf('\n', pos)
  return end < 0 ? text.length : end
}

function lastColumn(text: string, pos: number): number {
  return Math.max(lineStart(text, pos), lineEnd(text, pos) - 1)
}

export function clampNormal(text: string, caret: number): number {
  const pos = Math.max(0, Math.min(caret, text.length))
  return Math.min(pos, lastColumn(text, pos))
}

function charClass(c: string | undefined): number {
  if (c === undefined || /\s/.test(c)) return 0
  return /\w/.test(c) ? 1 : 2
}

function nextWordStart(text: string, pos: number): number {
  let i = pos
  const cls = charClass(text[i])
  if (cls !== 0) while (i < text.length && charClass(text[i]) === cls) i++
  while (i < text.length && charClass(text[i]) === 0) i++
  return i
}

function prevWordStart(text: string, pos: number): number {
  let i = pos - 1
  while (i > 0 && charClass(text[i]) === 0) i--
  const cls = charClass(text[i])
  while (i > 0 && charClass(text[i - 1]) === cls) i--
  return Math.max(0, i)
}

function wordEnd(text: string, pos: number): number {
  let i = pos + 1
  while (i < text.length && charClass(text[i]) === 0) i++
  const cls = charClass(text[i])
  while (i + 1 < text.length && charClass(text[i + 1]) === cls) i++
  return Math.min(i, Math.max(0, text.length - 1))
}

function repeat(count: number, pos: number, step: (p: number) => number): number {
  let p = pos
  for (let n = 0; n < count; n++) p = step(p)
  return p
}

function verticalTarget(text: string, caret: number, down: boolean, count: number): number {
  let pos = caret
  const column = caret - lineStart(text, caret)
  for (let n = 0; n < count; n++) {
    if (down) {
      const end = lineEnd(text, pos)
      if (end >= text.length) break
      pos = end + 1
    } else {
      const start = lineStart(text, pos)
      if (start === 0) break
      pos = lineStart(text, start - 1)
    }
  }
  const start = lineStart(text, pos)
  return Math.min(start + column, lastColumn(text, start))
}

export function motionTarget(
  text: string,
  caret: number,
  motion: VimMotion,
  count: number,
): number {
  switch (motion) {
    case 'h':
      return Math.max(lineStart(text, caret), caret - count)
    case 'l':
      return Math.min(lastColumn(text, caret), caret + count)
    case '0':
      return lineStart(text, caret)
    case '$':
      return lastColumn(text, caret)
    case 'w':
      return repeat(count, caret, (p) => nextWordStart(text, p))
    case 'b':
      return repeat(count, caret, (p) => prevWordStart(text, p))
    case 'e':
      return repeat(count, caret, (p) => wordEnd(text, p))
    case 'j':
      return verticalTarget(text, caret, true, count)
    case 'k':
      return verticalTarget(text, caret, false, count)
  }
}

export function canMoveVertically(text: string, caret: number, down: boolean): boolean {
  return down ? lineEnd(text, caret) < text.length : lineStart(text, caret) > 0
}

function operatorRange(
  text: string,
  caret: number,
  motion: VimMotion,
  count: number,
  change: boolean,
): [number, number] {
  switch (motion) {
    case 'h':
    case 'b':
    case '0':
      return [motionTarget(text, caret, motion, count), caret]
    case 'l':
      return [caret, Math.min(lineEnd(text, caret), caret + count)]
    case '$':
      return [caret, lineEnd(text, caret)]
    case 'e':
      return [caret, Math.min(text.length, motionTarget(text, caret, 'e', count) + 1)]
    default: {
      let to = motionTarget(text, caret, 'w', count)
      if (change && charClass(text[caret]) !== 0) {
        while (to > caret && charClass(text[to - 1]) === 0) to--
        return [caret, to]
      }
      const newline = text.lastIndexOf('\n', to - 1)
      return [caret, newline >= caret ? newline : to]
    }
  }
}

function linesRange(text: string, caret: number, count: number): [number, number] {
  const start = lineStart(text, caret)
  let end = lineEnd(text, caret)
  for (let n = 1; n < count && end < text.length; n++) end = lineEnd(text, end + 1)
  return [start, end]
}

function splice(text: string, from: number, to: number, insert = ''): string {
  return text.slice(0, from) + insert + text.slice(to)
}

function firstNonBlank(text: string, caret: number): number {
  let i = lineStart(text, caret)
  const end = lineEnd(text, caret)
  while (i < end && (text[i] === ' ' || text[i] === '\t')) i++
  return i
}

function applyInsert(text: string, caret: number, at: VimInsert): VimResult {
  const start = lineStart(text, caret)
  const end = lineEnd(text, caret)
  switch (at) {
    case 'i':
      return { text, caret, mode: 'insert' }
    case 'a':
      return { text, caret: Math.min(end, caret + 1), mode: 'insert' }
    case 'A':
      return { text, caret: end, mode: 'insert' }
    case 'I':
      return { text, caret: firstNonBlank(text, caret), mode: 'insert' }
    case 'o':
      return { text: splice(text, end, end, '\n'), caret: end + 1, mode: 'insert' }
    case 'O':
      return { text: splice(text, start, start, '\n'), caret: start, mode: 'insert' }
  }
}

function applyLines(text: string, caret: number, count: number, change: boolean): VimResult {
  const [start, end] = linesRange(text, caret, count)
  if (change) return { text: splice(text, start, end), caret: start, mode: 'insert' }
  if (end < text.length) {
    const next = splice(text, start, end + 1)
    return { text: next, caret: clampNormal(next, start), mode: 'normal' }
  }
  const from = start > 0 ? start - 1 : start
  const next = splice(text, from, end)
  return { text: next, caret: clampNormal(next, lineStart(next, from)), mode: 'normal' }
}

export function applyVimCommand(command: VimCommand, buffer: VimBuffer): VimResult {
  const { text, caret } = buffer
  switch (command.kind) {
    case 'move':
      return {
        text,
        caret: clampNormal(text, motionTarget(text, caret, command.motion, command.count)),
        mode: 'normal',
      }
    case 'deleteChar': {
      const to = Math.min(lineEnd(text, caret), caret + command.count)
      const next = splice(text, caret, to)
      return { text: next, caret: clampNormal(next, caret), mode: 'normal' }
    }
    case 'insert':
      return applyInsert(text, caret, command.at)
    case 'undo':
      return { text, caret, mode: 'normal' }
    case 'delete':
    case 'change': {
      const change = command.kind === 'change'
      if (command.motion === 'line') return applyLines(text, caret, command.count, change)
      const [from, to] = operatorRange(text, caret, command.motion, command.count, change)
      const next = splice(text, from, to)
      if (change) return { text: next, caret: from, mode: 'insert' }
      return { text: next, caret: clampNormal(next, from), mode: 'normal' }
    }
  }
}

export function enterNormal(buffer: VimBuffer): VimResult {
  const { text, caret } = buffer
  const back = caret > lineStart(text, caret) ? caret - 1 : caret
  return { text, caret: clampNormal(text, back), mode: 'normal' }
}

export function changesText(command: VimCommand): boolean {
  return command.kind === 'delete' || command.kind === 'change' || command.kind === 'deleteChar'
}
