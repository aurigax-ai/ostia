import { codeEscape, isControl, isHiddenFormat } from '../../shared/common/hiddenText'

const NAMED: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' }

function escaped(char: string): string {
  const code = char.charCodeAt(0)
  if (!isControl(code) && !isHiddenFormat(code)) return char
  return NAMED[char] ?? codeEscape(code)
}

export function lineField(value: unknown): string {
  return Array.from(String(value ?? ''), escaped).join('')
}

export function tsvLine(fields: readonly unknown[]): string {
  return fields.map(lineField).join('\t')
}
