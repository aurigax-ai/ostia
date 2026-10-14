import { describe, expect, it } from 'vitest'
import {
  COMMENT_MARKER,
  baselineOf,
  changedLines,
  mostChanged,
  parseLcov,
  patchCoverage,
  ranges,
  report,
} from '../scripts/coverageReport.mjs'

const ROOT = '/repo'
const BLOB = 'https://github.com/o/r/blob/abc'

const LCOV = [
  'TN:',
  'SF:/repo/src/main/a.ts',
  'DA:1,1',
  'DA:2,0',
  'DA:3,0',
  'DA:4,0',
  'DA:7,2',
  'end_of_record',
  'SF:src/shared/b.ts',
  'DA:10,0',
  'end_of_record',
  'SF:scripts/c.mjs',
  'DA:1,0',
  'end_of_record',
  '',
].join('\n')

const DIFF = [
  'diff --git a/src/main/a.ts b/src/main/a.ts',
  '--- a/src/main/a.ts',
  '+++ b/src/main/a.ts',
  '@@ -1,0 +2,3 @@',
  '+x',
  '+y',
  '+z',
  '@@ -9 +7 @@',
  '-old',
  '+new',
  'diff --git a/src/shared/gone.ts b/src/shared/gone.ts',
  '--- a/src/shared/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-a',
  '-b',
  'diff --git a/scripts/c.mjs b/scripts/c.mjs',
  '--- a/scripts/c.mjs',
  '+++ b/scripts/c.mjs',
  '@@ -1 +1 @@',
  '+text',
  '',
].join('\n')

const coverage = () => parseLcov(LCOV, ROOT)

const MAIN = {
  sha: 'ffffffffffff',
  total: { found: 7, hit: 4 },
  files: { 'src/main/a.ts': [5, 4], 'src/shared/b.ts': [1, 0], 'src/old.ts': [1, 0] },
}

describe('coverageReport', () => {
  it('reads lcov lines per repo-relative file', () => {
    const files = coverage()
    expect([...files.keys()]).toEqual(['src/main/a.ts', 'src/shared/b.ts', 'scripts/c.mjs'])
    expect(files.get('src/main/a.ts')?.get(2)).toBe(0)
  })

  it('keeps the totals of every file as the baseline main stores', () => {
    expect(baselineOf(coverage(), 'abc')).toEqual({
      sha: 'abc',
      total: { found: 7, hit: 2 },
      files: { 'src/main/a.ts': [5, 2], 'src/shared/b.ts': [1, 0], 'scripts/c.mjs': [1, 0] },
    })
  })

  it('takes added lines from a zero-context diff and skips deleted files', () => {
    const changed = changedLines(DIFF)
    expect([...(changed.get('src/main/a.ts') ?? [])]).toEqual([2, 3, 4, 7])
    expect(changed.has('src/shared/gone.ts')).toBe(false)
  })

  it('counts only changed lines in src/ that a test can run', () => {
    expect(patchCoverage(coverage(), changedLines(DIFF))).toEqual({
      executable: 4,
      covered: 1,
      files: [{ path: 'src/main/a.ts', uncovered: [2, 3, 4] }],
    })
  })

  it('folds consecutive lines into ranges', () => {
    expect(ranges([2, 3, 4, 9, 11, 12])).toEqual([
      [2, 4],
      [9, 9],
      [11, 12],
    ])
  })

  it('lists the files whose coverage moved most, new files by their own coverage', () => {
    const rows = mostChanged(baselineOf(coverage(), 'abc'), MAIN)
    expect(rows.map((row) => [row.path, row.delta === null ? null : row.delta.toFixed(2)])).toEqual(
      [
        ['src/main/a.ts', '-0.40'],
        ['scripts/c.mjs', null],
      ],
    )
  })

  it('compares the PR with main and links the changed lines no test ran', () => {
    const files = coverage()
    const text = report({
      current: baselineOf(files, 'abc'),
      baseline: MAIN,
      patch: patchCoverage(files, changedLines(DIFF)),
      blobUrl: BLOB,
    })
    expect(text.startsWith(`${COMMENT_MARKER}\n`)).toBe(true)
    expect(text).toContain('Lines: 28.6% (2 of 7); main 57.1% at fffffff (-28.6 points)')
    expect(text).toContain('Changed lines a test ran: 1 of 4 (25.0%)')
    expect(text).toContain(
      `| [src/main/a.ts](${BLOB}/src/main/a.ts) | [2-4](${BLOB}/src/main/a.ts#L2-L4) |`,
    )
    expect(text).toContain(`| [src/main/a.ts](${BLOB}/src/main/a.ts) | 80.0% | 40.0% | -40.0 |`)
    expect(text).toContain(`| [scripts/c.mjs](${BLOB}/scripts/c.mjs) | new | 0.0% | new |`)
  })

  it('says when there is no coverage of main to compare with', () => {
    const text = report({
      current: baselineOf(coverage(), 'abc'),
      baseline: null,
      patch: null,
      blobUrl: BLOB,
    })
    expect(text).toContain('No coverage of main to compare with yet.')
    expect(text).not.toContain('Changed lines')
    expect(text).not.toContain('changed most')
  })

  it('says so when no changed line is one a test can run', () => {
    const files = coverage()
    const text = report({
      current: baselineOf(files, 'abc'),
      baseline: MAIN,
      patch: patchCoverage(files, new Map([['scripts/c.mjs', new Set([1])]])),
      blobUrl: BLOB,
    })
    expect(text).toContain('No changed line in `src/` is one a test can run.')
  })
})
