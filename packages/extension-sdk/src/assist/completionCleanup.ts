import { COMPLETION_TEXT_MAX } from '../contract/assist'

const ECHO_MIN = 3
const CLOSER = /^[\])}]/

function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

function afterEcho(line: string, echo: string): string | null {
  let i = 0
  for (const ch of squash(echo)) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (line[i] !== ch) return null
    i++
  }
  return line.slice(i)
}

interface Indent {
  from: string
  to: string
}

function reindent(line: string, map: Indent): string {
  if (!line.trim()) return ''
  if (line.startsWith(map.from)) return map.to + line.slice(map.from.length)
  const indent = indentOf(line)
  const keep = Math.max(0, map.to.length - (map.from.length - indent.length))
  return map.to.slice(0, keep) + line.slice(indent.length)
}

function echoedLines(out: string[], prefixLines: string[]): number {
  const cursorAt = prefixLines.length - 1
  const cursorLine = prefixLines[cursorAt]
  const squashed = prefixLines.map(squash)
  const outSquashed = out.map(squash)
  for (let start = 0; start < cursorAt; start++) {
    const count = cursorAt - start
    if (out.length < count) continue
    let size = squashed[cursorAt].length
    let same = true
    for (let i = 0; i < count && same; i++) {
      same = outSquashed[i] === squashed[start + i]
      size += squashed[start + i].length
    }
    if (same && size >= ECHO_MIN && afterEcho(out[count] ?? '', cursorLine) !== null) return count
  }
  return 0
}

function cursorEcho(line: string, cursorLine: string): string | null {
  if (cursorLine && line.startsWith(cursorLine)) return line.slice(cursorLine.length)
  const size = squash(cursorLine).length
  if (size === 0) return cursorLine ? line : null
  return size >= ECHO_MIN ? afterEcho(line, cursorLine) : null
}

function partialEcho(line: string, cursorLine: string): string | null {
  for (let j = indentOf(cursorLine).length + 1; j < cursorLine.length; j++) {
    if (!/\s/.test(cursorLine[j - 1]) || /\s/.test(cursorLine[j])) continue
    const tail = cursorLine.slice(j)
    if (squash(tail).length < ECHO_MIN) return null
    const rest = afterEcho(line, tail)
    if (rest !== null) return rest
  }
  return null
}

function guessIndent(rest: string[], cursorLine: string): Indent {
  const cursorIndent = indentOf(cursorLine)
  const first = rest.find((l) => l.trim())
  const flush = first !== undefined && indentOf(first) === '' && !CLOSER.test(first)
  return flush && cursorIndent && cursorLine.trim()
    ? { from: '', to: cursorIndent }
    : { from: '', to: '' }
}

function dropEchoAndIndent(text: string, prefix: string): string {
  const prefixLines = prefix.split('\n')
  const cursorLine = prefixLines[prefixLines.length - 1]
  const out = text.split('\n')
  const skipped = echoedLines(out, prefixLines)
  const line = out[skipped] ?? ''
  const rest = out.slice(skipped + 1)
  const echoed = skipped > 0 ? afterEcho(line, cursorLine) : cursorEcho(line, cursorLine)
  let head: string
  let map: Indent
  if (echoed !== null && cursorLine !== '') {
    map = { from: indentOf(line), to: indentOf(cursorLine) }
    head = squash(cursorLine) === '' ? reindent(line, map).slice(cursorLine.length) : echoed
  } else if (echoed !== null && skipped > 0) {
    map = { from: indentOf(out[0]), to: indentOf(prefixLines[prefixLines.length - 1 - skipped]) }
    head = reindent(line, map)
  } else {
    head = partialEcho(line, cursorLine) ?? line
    map = guessIndent(rest, cursorLine)
  }
  if (/\s$/.test(cursorLine)) head = head.replace(/^[ \t]+/, '')
  return [head, ...rest.map((l) => reindent(l, map))].join('\n')
}

function dropSuffixLines(text: string, suffix: string): string {
  const lines = text.split('\n')
  const ahead = suffix
    .split('\n')
    .slice(1)
    .map(squash)
    .filter((l) => l !== '')
  for (let i = 1; i < lines.length; i++) {
    const tail = lines
      .slice(i)
      .map(squash)
      .filter((l) => l !== '')
    if (tail.length === 0 || tail.length > ahead.length) continue
    const same = tail.every((l, k) => l === ahead[k])
    if (same && tail.join('').length >= ECHO_MIN) return lines.slice(0, i).join('\n')
  }
  return text
}

const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function closesMoreThanOpens(text: string, closer: string): boolean {
  const opener = OPENER_OF[closer]
  if (!opener) return true
  let depth = 0
  for (const ch of text) {
    if (ch === opener) depth++
    else if (ch === closer) depth--
  }
  return depth < 0
}

function dropSuffixOverlap(text: string, suffix: string): string {
  const head = suffix.replace(/^\s+/, '')
  if (!head) return text
  const trimmed = text.trimEnd()
  for (let n = Math.min(trimmed.length, head.length); n > 0; n--) {
    const tail = trimmed.slice(trimmed.length - n)
    if (head.startsWith(tail) && /^\S/.test(tail) && closesMoreThanOpens(trimmed, tail[0])) {
      const before = trimmed.slice(0, trimmed.length - n)
      if (before === '' || /\s$/.test(before) || /^[\])};,]/.test(tail)) return before
    }
  }
  return text
}

export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/^```[\w-]*\n/, '')
    .replace(/\n?```\s*$/, '')
    .replace(/<\/?(?:prefix|suffix|middle|cursor)>/gi, '')
  text = dropEchoAndIndent(text, prefix)
  text = dropSuffixLines(text, suffix)
  text = dropSuffixOverlap(text, suffix)
  text = dropUnopenedClosers(text.trimEnd(), prefix)
  return text.slice(0, COMPLETION_TEXT_MAX)
}

function dropUnopenedClosers(text: string, prefix: string): string {
  let out = text
  for (const closer of [')', ']']) {
    let extra = 0
    while (out.endsWith(closer) && closesMoreThanOpens(prefix + out, closer) && extra < 8) {
      out = out.slice(0, -1).trimEnd()
      extra++
    }
  }
  return out
}
