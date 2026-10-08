import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

export const ROOT = process.cwd()
const REGISTRY = resolve(ROOT, 'test/quarantine.json')
const MAX_DAYS = 30
const REMIND_DAYS = 7
const PLATFORMS = ['linux', 'darwin']
const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function loadQuarantine() {
  return JSON.parse(readFileSync(REGISTRY, 'utf8'))
}

export function quarantineMode() {
  return process.env.TEST_QUARANTINE === 'only' ? 'only' : 'skip'
}

export function activeEntries() {
  return loadQuarantine().filter(
    (entry) => !entry.platforms || entry.platforms.includes(process.platform),
  )
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

export function playwrightPattern(entry) {
  const file = relative(resolve(ROOT, 'e2e'), resolve(ROOT, entry.file))
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

export function quarantineProblems(
  entries,
  { today, issueStates = {}, root = ROOT, enforceExpiry = true },
) {
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
    else if (enforceExpiry && issueStates[entry.issue] === 'closed')
      fail(`issue #${entry.issue} is closed`)
    const untilMs =
      typeof entry.until === 'string' && ISO_DATE.test(entry.until)
        ? Date.parse(`${entry.until}T00:00:00Z`)
        : Number.NaN
    if (Number.isNaN(untilMs)) fail('until must be a date like 2026-10-31')
    else if (untilMs < todayMs) {
      if (enforceExpiry) fail(`expired on ${entry.until}`)
    } else if (untilMs - todayMs > MAX_DAYS * DAY_MS)
      fail(`until is more than ${MAX_DAYS} days out`)
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

function daysLeft(entry, today) {
  return Math.round(
    (Date.parse(`${entry.until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  )
}

export function dueForReminder(entries, today) {
  return entries.filter(
    (entry) => ISO_DATE.test(entry.until) && daysLeft(entry, today) <= REMIND_DAYS,
  )
}

export function reminderMarker(entry) {
  return `<!-- quarantine-reminder: ${entryKey(entry)} until ${entry.until} -->`
}

export function unreminded(entries, commentBodies) {
  return entries.filter(
    (entry) => !commentBodies.some((body) => body.includes(reminderMarker(entry))),
  )
}

export function reminderBody(entries, today) {
  const lines = entries.map((entry) => {
    const left = daysLeft(entry, today)
    const when =
      left < 0
        ? `expired on ${entry.until}`
        : left === 0
          ? 'expires today'
          : `expires on ${entry.until}`
    return `- \`${entryKey(entry)}\` ${when}`
  })
  return [
    'Quarantined tests for this issue in `test/quarantine.json`:',
    '',
    ...lines,
    '',
    'Once a date passes, CI fails on pushes to main, the nightly run and release tags.',
    `Fix the test and remove its entry, or give it a new date no more than ${MAX_DAYS} days out.`,
    '',
    ...entries.map(reminderMarker),
  ].join('\n')
}
