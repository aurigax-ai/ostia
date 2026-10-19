const NAMED: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' }

function escaped(char: string): string {
  const code = char.charCodeAt(0)
  if (code >= 0x20 && code !== 0x7f) return char
  return NAMED[char] ?? `\\x${code.toString(16).padStart(2, '0')}`
}

export function lineField(value: unknown): string {
  return Array.from(String(value ?? ''), escaped).join('')
}

export function tsvLine(fields: readonly unknown[]): string {
  return fields.map(lineField).join('\t')
}
