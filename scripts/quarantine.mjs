import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  ROOT,
  activeEntries,
  dueForReminder,
  entryKey,
  loadQuarantine,
  quarantineProblems,
  reminderBody,
  unreminded,
} from '../test/quarantine.mjs'
import { githubRequestFrom } from './github.mjs'

const USAGE = [
  'usage: node scripts/quarantine.mjs issues [--today=YYYY-MM-DD]',
  '       node scripts/quarantine.mjs remind [--today=YYYY-MM-DD] [--dry-run]',
  '       node scripts/quarantine.mjs unit <runs> | e2e <runs> [playwright args]',
].join('\n')

async function issueStates(entries) {
  const github = githubRequestFrom(process.env)
  const states = {}
  for (const issue of new Set(entries.map((entry) => entry.issue))) {
    states[issue] = (await github(`issues/${issue}`)).state
  }
  return states
}

function isRealDate(value) {
  const ms = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value
}

function todayFrom(flags) {
  const today = flags.find((flag) => flag.startsWith('--today='))?.slice('--today='.length)
  if (today === undefined) return new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !isRealDate(today)) {
    console.error(USAGE)
    process.exit(2)
  }
  return today
}

async function commentBodies(github, issue) {
  const bodies = []
  for (let page = 1; ; page++) {
    const comments = await github(`issues/${issue}/comments?per_page=100&page=${page}`)
    bodies.push(...comments.map((comment) => comment.body ?? ''))
    if (comments.length < 100) return bodies
  }
}

async function remind(flags) {
  const today = todayFrom(flags)
  const dryRun = flags.includes('--dry-run')
  const due = dueForReminder(loadQuarantine(), today)
  const github = githubRequestFrom(process.env)
  const byIssue = Map.groupBy(due, (entry) => entry.issue)
  for (const [issue, entries] of byIssue) {
    const pending = unreminded(entries, await commentBodies(github, issue))
    if (!pending.length) {
      console.log(`quarantine: #${issue} already reminded`)
      continue
    }
    const body = reminderBody(pending, today)
    if (dryRun) {
      console.log(`quarantine: would comment on #${issue}:\n${body}`)
      continue
    }
    await github(`issues/${issue}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
    console.log(`quarantine: reminded #${issue} of ${pending.length} entries`)
  }
  if (!byIssue.size) console.log(`quarantine: nothing expires within a week of ${today}`)
}

async function checkIssues(flags) {
  const entries = loadQuarantine()
  const today = todayFrom(flags)
  const problems = quarantineProblems(entries, { today, issueStates: await issueStates(entries) })
  for (const problem of problems) console.error(`quarantine: ${problem}`)
  if (problems.length) {
    console.error('Remove the entry and its skip, or file a new issue and date for it.')
    process.exit(1)
  }
  console.log(`quarantine: ${entries.length} entries, every issue open and every date ahead`)
}

function tally(entries) {
  return new Map(entries.map((entry) => [entryKey(entry), { passed: 0, failed: 0 }]))
}

function count(counts, file, titles, status) {
  const row = counts.get(`${file} › ${titles.join(' > ')}`)
  if (!row) return
  if (status === 'passed') row.passed++
  else if (status === 'failed' || status === 'timedOut' || status === 'interrupted') row.failed++
}

const FAILURE_DETAIL_MAX_CHARS = 6000
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function printFailure(key, run, parts) {
  const detail = parts
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    .replace(ANSI, '')
  console.log(
    `quarantine: FAILED ${key} (run ${run})\n${detail.slice(0, FAILURE_DETAIL_MAX_CHARS)}\n`,
  )
}

function report(counts, runner) {
  const lines = [...counts].map(([key, { passed, failed }]) =>
    passed + failed === 0
      ? `| ${key} | did not run |`
      : `| ${key} | ${passed}/${passed + failed} passed${failed ? `, ${failed} failed` : ''} |`,
  )
  const table = [
    `### Quarantined ${runner} tests (${process.platform})`,
    '',
    '| Test | Result |',
    '|---|---|',
    ...lines,
  ].join('\n')
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`)
}

function runUnit(runs) {
  const entries = activeEntries().filter((entry) => !entry.file.startsWith('e2e/'))
  if (!entries.length) return console.log(`quarantine: no unit entries for ${process.platform}`)
  const counts = tally(entries)
  const dir = mkdtempSync(join(tmpdir(), 'ostia-quarantine-'))
  const files = [...new Set(entries.map((entry) => entry.file))]
  try {
    for (let run = 1; run <= runs; run++) {
      const output = join(dir, `unit-${run}.json`)
      spawnSync(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--project',
          'node',
          '--project',
          'dom',
          ...files,
          '--reporter=json',
          `--outputFile=${output}`,
        ],
        { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TEST_QUARANTINE: 'only' } },
      )
      const result = JSON.parse(readFileSync(output, 'utf8'))
      for (const file of result.testResults) {
        for (const test of file.assertionResults) {
          const titles = [...test.ancestorTitles, test.title]
          if (test.status === 'failed') {
            printFailure(
              `${relative(ROOT, file.name)} › ${titles.join(' > ')}`,
              run,
              test.failureMessages ?? [],
            )
          }
          count(
            counts,
            relative(ROOT, file.name),
            [...test.ancestorTitles, test.title],
            test.status,
          )
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  report(counts, 'unit')
}

function collectSpecs(suite, titles, counts) {
  const inner = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      for (const [index, result] of test.results.entries()) {
        const key = `e2e/${spec.file} › ${[...inner, spec.title].join(' > ')}`
        if (counts.has(key) && !['passed', 'skipped'].includes(result.status)) {
          printFailure(key, `${test.repeatEachIndex ?? index}, ${result.status}`, [
            ...(result.errors ?? []).map((error) => error.message),
            ...(result.stderr ?? []).map((chunk) => chunk.text),
          ])
        }
        count(counts, `e2e/${spec.file}`, [...inner, spec.title], result.status)
      }
    }
  }
  for (const child of suite.suites ?? []) collectSpecs(child, inner, counts)
}

function runE2e(runs, args) {
  const entries = activeEntries().filter((entry) => entry.file.startsWith('e2e/'))
  if (!entries.length) return console.log(`quarantine: no e2e entries for ${process.platform}`)
  const counts = tally(entries)
  const dir = mkdtempSync(join(tmpdir(), 'ostia-quarantine-'))
  const output = join(dir, 'e2e.json')
  try {
    spawnSync(
      'pnpm',
      [
        'test:e2e',
        ...new Set(entries.map((entry) => entry.file)),
        `--repeat-each=${runs}`,
        '--reporter=json',
        ...args,
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, TEST_QUARANTINE: 'only', PLAYWRIGHT_JSON_OUTPUT_NAME: output },
      },
    )
    for (const suite of JSON.parse(readFileSync(output, 'utf8')).suites)
      collectSpecs(suite, [], counts)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  report(counts, 'e2e')
}

const [command, runsArg, ...rest] = process.argv.slice(2)
const runs = Number(runsArg)
const flags = process.argv.slice(3)
if (command === 'issues') await checkIssues(flags)
else if (command === 'remind') await remind(flags)
else if (command === 'unit' && runs > 0) runUnit(runs)
else if (command === 'e2e' && runs > 0) runE2e(runs, rest)
else {
  console.error(USAGE)
  process.exit(2)
}
