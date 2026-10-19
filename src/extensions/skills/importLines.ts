import { RULE_MAX } from './rule'

const IMPORT_MAX_BYTES = 256 * 1024
const IMPORT_MAX_LINES = 400

export function importCandidates(text: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  let fenced = false
  for (const raw of text.slice(0, IMPORT_MAX_BYTES).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced || /^\s*(#|>|\||<)/.test(raw)) continue
    const line = raw
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
      .replace(/\*\*|__/g, '')
      .trim()
    if (line.length < 8 || /^[-=_*\s]+$/.test(line) || /:$/.test(line)) continue
    if (line.length > RULE_MAX * 2 || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
    if (lines.length >= IMPORT_MAX_LINES) break
  }
  return lines
}
