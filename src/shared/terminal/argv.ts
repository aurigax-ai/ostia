export function splitArgs(line: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let inToken = false
  let quote: '"' | "'" | null = null
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) return null
  if (inToken) tokens.push(current)
  return tokens
}
