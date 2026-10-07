import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

export const ROOT = process.cwd()
export const REGISTRY = resolve(ROOT, 'test/quarantine.json')
export const MAX_DAYS = 30
export const PLATFORMS = ['linux', 'darwin']
const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function loadQuarantine(path = REGISTRY) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function quarantineMode() {
  return process.env.TEST_QUARANTINE === 'only' ? 'only' : 'skip'
}

export function appliesHere(entry, platform = process.platform) {
  return !entry.platforms || entry.platforms.includes(platform)
}

export function activeEntries(entries = loadQuarantine(), platform = process.platform) {
  return entries.filter((entry) => appliesHere(entry, platform))
}

export function entryKey(entry) {
  return `${entry.file} › ${entry.name}`
}

export function isListed(entries, file, name) {
  const rel = relative(ROOT, file)
  return entries.some((entry) => entry.file === rel && entry.name === name)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function playwrightPattern(entry, testDir = 'e2e') {
  const file = relative(resolve(ROOT, testDir), resolve(ROOT, entry.file))
  const title = entry.name.split(' > ').join(' ')
  return new RegExp(`(^| )${escapeRegExp(file)} ${escapeRegExp(title)}$`)
}

export function playwrightFilter(entries) {
  const patterns = entries.map((entry) => playwrightPattern(entry))
  if (quarantineMode() === 'only') return { grep: patterns.length ? patterns : [/$^/] }
  return patterns.length ? { grepInvert: patterns } : {}
}

export function announce(entries, runner) {
  if (quarantineMode() === 'only' || entries.length === 0) return
  const lines = entries.map(
    (entry) => `  ${entryKey(entry)} (#${entry.issue}, until ${entry.until})`,
  )
  console.warn(`${runner}: quarantined by test/quarantine.json, skipped:\n${lines.join('\n')}`)
}

export function quarantineProblems(entries, { today, issueStates = {}, root = ROOT }) {
  if (!Array.isArray(entries)) return ['the registry is not a list']
  const problems = []
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  const seen = new Set()
  for (const entry of entries) {
    const key = entry && typeof entry === 'object' ? entryKey(entry) : String(entry)
    const fail = (why) => problems.push(`${key}: ${why}`)
    if (!entry || typeof entry !== 'object') {
      fail('not an object')
      continue
    }
    const extra = Object.keys(entry).filter(
      (k) => !['file', 'name', 'issue', 'until', 'platforms'].includes(k),
    )
    if (extra.length) fail(`unknown field ${extra.join(', ')}`)
    if (typeof entry.file !== 'string' || typeof entry.name !== 'string' || !entry.name) {
      fail('needs a file and a name')
      continue
    }
    if (seen.has(key)) fail('listed twice')
    seen.add(key)
    if (!Number.isInteger(entry.issue) || entry.issue <= 0) fail('needs an issue number')
    else if (issueStates[entry.issue] === 'closed') fail(`issue #${entry.issue} is closed`)
    const untilMs =
      typeof entry.until === 'string' && ISO_DATE.test(entry.until)
        ? Date.parse(`${entry.until}T00:00:00Z`)
        : Number.NaN
    if (Number.isNaN(untilMs)) fail('until must be a date like 2026-10-31')
    else if (untilMs < todayMs) fail(`expired on ${entry.until}`)
    else if (untilMs - todayMs > MAX_DAYS * DAY_MS) fail(`until is more than ${MAX_DAYS} days out`)
    if (
      entry.platforms !== undefined &&
      (!Array.isArray(entry.platforms) ||
        entry.platforms.length === 0 ||
        entry.platforms.some((p) => !PLATFORMS.includes(p)))
    ) {
      fail(`platforms must list some of ${PLATFORMS.join(', ')}`)
    }
    const path = resolve(root, entry.file)
    if (!existsSync(path)) {
      fail('no such file')
      continue
    }
    const source = readFileSync(path, 'utf8')
    const missing = entry.name.split(' > ').filter((title) => !source.includes(title))
    if (missing.length) fail(`no test titled ${JSON.stringify(missing.join(' > '))} in the file`)
  }
  return problems
}
