export type ShellTokenKind =
  | 'command'
  | 'argument'
  | 'flag'
  | 'string'
  | 'variable'
  | 'assignment'
  | 'operator'
  | 'comment'
  | 'space'

export interface ShellToken {
  kind: ShellTokenKind
  text: string
  start: number
  end: number
}

type WordPart = 'plain' | 'string' | 'variable'

const RESERVED_BEFORE_COMMAND = new Set([
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  '!',
  'time',
  '{',
])

const SEPARATORS = ['&&', '||', ';;', '|&', '|', ';', '&', '(']
const REDIRECT = /^(?:&>>|&>|>>|>&|>\||<<<|<<|<&|<>|>|<)/
const FD_REDIRECT = /^\d+(?:>>|>&|>\||>|<&|<>|<<<|<<|<)/
const PLAIN_STOP = /[\s|&;()<>'"$`\\]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SPECIAL_PARAMETER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?$#@*!-])/

function closingQuote(text: string, from: number): number {
  let i = from + 1
  while (i < text.length) {
    if (text[i] === '\\') i += 2
    else if (text[i] === '"') return i + 1
    else i++
  }
  return text.length
}

function closingBrace(text: string, from: number): number {
  const end = text.indexOf('}', from)
  return end < 0 ? text.length : end + 1
}

function closingArithmetic(text: string, from: number): number {
  const end = text.indexOf('))', from + 3)
  return end < 0 ? text.length : end + 2
}

function plainEnd(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      if (text[i + 1] === '\n') break
      i += 2
      continue
    }
    if (PLAIN_STOP.test(c)) break
    i++
  }
  return Math.min(i, text.length)
}

export function tokenizeShell(text: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let expectCommand = true
  let word: { kind: ShellTokenKind; start: number } | null = null
  let i = 0

  const push = (kind: ShellTokenKind, start: number, end: number): void => {
    tokens.push({ kind, text: text.slice(start, end), start, end })
  }

  const endWord = (): void => {
    if (!word) return
    const wordText = text.slice(word.start, i)
    if (word.kind === 'command') expectCommand = RESERVED_BEFORE_COMMAND.has(wordText)
    else if (word.kind !== 'assignment') expectCommand = false
    word = null
  }

  const pushPart = (part: WordPart, end: number): void => {
    const start = i
    if (!word) {
      const run = text.slice(start, end)
      let kind: ShellTokenKind
      if (expectCommand) kind = part === 'plain' && ASSIGNMENT.test(run) ? 'assignment' : 'command'
      else kind = part === 'plain' && run.startsWith('-') ? 'flag' : 'argument'
      word = { kind, start }
      push(part === 'plain' ? kind : part, start, end)
    } else if (part === 'plain') {
      const kind = word.kind
      push(
        kind === 'command' || kind === 'flag' || kind === 'assignment' ? kind : 'argument',
        start,
        end,
      )
    } else {
      push(part, start, end)
    }
    i = end
  }

  const separator = (end: number, next: boolean): void => {
    endWord()
    push('operator', i, end)
    i = end
    expectCommand = next
  }

  while (i < text.length) {
    const c = text[i]
    const rest = text.slice(i)
    if (c === '\\' && text[i + 1] === '\n') {
      endWord()
      push('space', i, i + 2)
      i += 2
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      let j = i
      while (text[j] === ' ' || text[j] === '\t') j++
      push('space', i, j)
      i = j
      continue
    }
    if (c === '\n') {
      separator(i + 1, true)
      continue
    }
    if (c === '#' && !word) {
      const newline = text.indexOf('\n', i)
      const end = newline < 0 ? text.length : newline
      push('comment', i, end)
      i = end
      continue
    }
    const fd = word ? null : FD_REDIRECT.exec(rest)
    const redirect = fd ?? REDIRECT.exec(rest)
    if (redirect) {
      const keep: boolean = expectCommand
      endWord()
      push('operator', i, i + redirect[0].length)
      i += redirect[0].length
      expectCommand = keep
      continue
    }
    const sep = SEPARATORS.find((s) => rest.startsWith(s))
    if (sep) {
      separator(i + sep.length, true)
      continue
    }
    if (c === ')') {
      separator(i + 1, false)
      continue
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      pushPart('string', close < 0 ? text.length : close + 1)
      continue
    }
    if (c === '"') {
      pushPart('string', closingQuote(text, i))
      continue
    }
    if (c === '`') {
      const close = text.indexOf('`', i + 1)
      pushPart('variable', close < 0 ? text.length : close + 1)
      continue
    }
    if (c === '$') {
      if (rest.startsWith('$((')) {
        pushPart('variable', closingArithmetic(text, i))
        continue
      }
      if (rest.startsWith('$(')) {
        separator(i + 2, true)
        continue
      }
      if (rest.startsWith('${')) {
        pushPart('variable', closingBrace(text, i))
        continue
      }
      if (rest.startsWith("$'")) {
        const close = text.indexOf("'", i + 2)
        pushPart('string', close < 0 ? text.length : close + 1)
        continue
      }
      const param = SPECIAL_PARAMETER.exec(rest)
      pushPart(param ? 'variable' : 'plain', i + (param ? param[0].length : 1))
      continue
    }
    pushPart('plain', Math.max(plainEnd(text, i), i + 1))
  }
  return tokens
}

export function isCommandPosition(text: string, start: number): boolean {
  const last = tokenizeShell(`${text.slice(0, start)}x`).at(-1)
  return last?.kind === 'command' && last.start === start
}

export function firstCommand(line: string): string | null {
  return tokenizeShell(line).find((t) => t.kind === 'command')?.text ?? null
}
