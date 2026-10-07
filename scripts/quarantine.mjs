import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  ROOT,
  activeEntries,
  entryKey,
  loadQuarantine,
  quarantineProblems,
} from '../test/quarantine.mjs'

const USAGE =
  'usage: node scripts/quarantine.mjs issues | unit <runs> | e2e <runs> [playwright args]'

async function issueStates(entries) {
  const repo = process.env.GITHUB_REPOSITORY || 'aurigax-ai/ostia'
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ostia-quarantine' }
  if (token) headers.authorization = `Bearer ${token}`
  const states = {}
  for (const issue of new Set(entries.map((entry) => entry.issue))) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issue}`, { headers })
    if (!res.ok) throw new Error(`issue #${issue}: GitHub answered ${res.status}`)
    states[issue] = (await res.json()).state
  }
  return states
}

async function checkIssues() {
  const entries = loadQuarantine()
  const today = new Date().toISOString().slice(0, 10)
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
      for (const result of test.results) {
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
if (command === 'issues') await checkIssues()
else if (command === 'unit' && runs > 0) runUnit(runs)
else if (command === 'e2e' && runs > 0) runE2e(runs, rest)
else {
  console.error(USAGE)
  process.exit(2)
}
