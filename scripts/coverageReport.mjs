import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePatch } from 'diff'

const USAGE = [
  'usage: node scripts/coverageReport.mjs baseline <lcov.info>',
  '       node scripts/coverageReport.mjs report <lcov.info> [--base <ref>] [--baseline <baseline.json>]',
].join('\n')

export const COMMENT_MARKER = '<!-- coverage-report -->'
const MOST_CHANGED = 10
const PATCH_PREFIXES = ['src/']

export function parseLcov(text, root) {
  const files = new Map()
  let lines = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      const path = line.slice(3)
      lines = new Map()
      files.set(isAbsolute(path) ? relative(root, path) : path, lines)
    } else if (line.startsWith('DA:') && lines) {
      const [number, hits] = line.slice(3).split(',')
      lines.set(Number(number), Number(hits))
    } else if (line === 'end_of_record') {
      lines = null
    }
  }
  return files
}

export function changedLines(diff) {
  const files = new Map()
  for (const { newFileName, hunks } of parsePatch(diff)) {
    if (!newFileName?.startsWith('b/')) continue
    const lines = new Set()
    for (const { newStart, newLines } of hunks)
      for (let n = newStart; n < newStart + newLines; n++) lines.add(n)
    files.set(newFileName.slice(2), lines)
  }
  return files
}

function count(lines) {
  let hit = 0
  for (const hits of lines.values()) if (hits > 0) hit++
  return { found: lines.size, hit }
}

export function baselineOf(coverage, sha) {
  const files = {}
  let found = 0
  let hit = 0
  for (const [path, lines] of coverage) {
    const c = count(lines)
    files[path] = [c.found, c.hit]
    found += c.found
    hit += c.hit
  }
  return { sha, total: { found, hit }, files }
}

export function patchCoverage(coverage, changed) {
  const files = []
  let executable = 0
  let covered = 0
  for (const [path, numbers] of changed) {
    if (!PATCH_PREFIXES.some((prefix) => path.startsWith(prefix))) continue
    const lines = coverage.get(path)
    if (!lines) continue
    const uncovered = []
    for (const n of [...numbers].sort((a, b) => a - b)) {
      if (!lines.has(n)) continue
      executable++
      if (lines.get(n) > 0) covered++
      else uncovered.push(n)
    }
    if (uncovered.length > 0) files.push({ path, uncovered })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { executable, covered, files }
}

const rate = ([found, hit]) => (found === 0 ? 1 : hit / found)

export function mostChanged(current, baseline, limit = MOST_CHANGED) {
  const rows = []
  for (const [path, now] of Object.entries(current.files)) {
    const before = baseline.files[path]
    const delta = before ? rate(now) - rate(before) : null
    if (delta !== null && Math.abs(delta) < 0.0005) continue
    rows.push({ path, before: before ?? null, now, delta })
  }
  const weight = (row) => (row.delta === null ? rate(row.now) : Math.abs(row.delta))
  rows.sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path))
  return rows.slice(0, limit)
}

export function ranges(numbers) {
  const out = []
  for (const n of numbers) {
    const last = out.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  return out
}

const percent = (part, whole) => (whole === 0 ? '100.0' : ((part / whole) * 100).toFixed(1))
const pct = (pair) => `${(rate(pair) * 100).toFixed(1)}%`

function signed(delta) {
  const points = (delta * 100).toFixed(1)
  return delta > 0 ? `+${points}` : points
}

export function report({ current, baseline, patch, blobUrl }) {
  const { found, hit } = current.total
  const out = [COMMENT_MARKER, '### Coverage', '']
  const totalLine = `Lines: ${percent(hit, found)}% (${hit} of ${found})`
  if (baseline) {
    const delta = rate([found, hit]) - rate([baseline.total.found, baseline.total.hit])
    out.push(
      `${totalLine}; main ${percent(baseline.total.hit, baseline.total.found)}% at ${baseline.sha.slice(0, 7)} (${signed(delta)} points)`,
    )
  } else {
    out.push(totalLine, '', 'No coverage of main to compare with yet.')
  }
  if (patch) {
    out.push('', '#### Changed lines', '')
    if (patch.executable === 0) {
      out.push('No changed line in `src/` is one a test can run.')
    } else {
      out.push(
        `Changed lines a test ran: ${patch.covered} of ${patch.executable} (${percent(patch.covered, patch.executable)}%)`,
      )
      if (patch.files.length > 0) {
        out.push('', '| File | Lines no test ran |', '|---|---|')
        for (const { path, uncovered } of patch.files) {
          const links = ranges(uncovered).map(([from, to]) => {
            const label = from === to ? `${from}` : `${from}-${to}`
            const anchor = from === to ? `L${from}` : `L${from}-L${to}`
            return `[${label}](${blobUrl}/${path}#${anchor})`
          })
          out.push(`| [${path}](${blobUrl}/${path}) | ${links.join(', ')} |`)
        }
      }
    }
  }
  if (baseline) {
    const rows = mostChanged(current, baseline)
    if (rows.length > 0) {
      out.push(
        '',
        '#### Files whose coverage changed most',
        '',
        '| File | main | now | change |',
        '|---|---|---|---|',
      )
      for (const row of rows) {
        const before = row.before ? pct(row.before) : 'new'
        const change = row.delta === null ? 'new' : signed(row.delta)
        out.push(
          `| [${row.path}](${blobUrl}/${row.path}) | ${before} | ${pct(row.now)} | ${change} |`,
        )
      }
    }
  }
  return `${out.join('\n')}\n`
}

function git(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim()
}

function option(args, name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

function main(args, env) {
  const [command, lcovPath, ...rest] = args
  if (!lcovPath || (command !== 'baseline' && command !== 'report')) {
    console.error(USAGE)
    return 2
  }
  const root = process.cwd()
  const sha = git(['rev-parse', 'HEAD'], root)
  const coverage = parseLcov(readFileSync(lcovPath, 'utf8'), root)
  const current = baselineOf(coverage, sha)
  if (command === 'baseline') {
    process.stdout.write(`${JSON.stringify(current)}\n`)
    return 0
  }
  const base = option(rest, '--base')
  const baselinePath = option(rest, '--baseline')
  const baseline =
    baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null
  const patch = base
    ? patchCoverage(
        coverage,
        changedLines(git(['diff', '--unified=0', '--no-color', `${base}...HEAD`], root)),
      )
    : null
  const blobUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${sha}`
  process.stdout.write(report({ current, baseline, patch, blobUrl }))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.env)
}
