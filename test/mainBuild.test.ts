import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ciPassed, mainBuildRunOf, tagsToPrune } from '../scripts/mainBuild.mjs'

const SHA = '42f8723c403c5fd93046d5ba89874bc72cf514b4'
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'mainBuild.mjs')

const checkRun = (overrides: Record<string, unknown> = {}) => ({
  name: 'ci-result',
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
  check_suite: { id: 7 },
  ...overrides,
})

const mainBuild = (run: number) => ({ tagName: `v0.5.10-main.${run}`, isPrerelease: true })

describe('mainBuildRunOf', () => {
  it('reads the run number of a main build tag only', () => {
    expect(mainBuildRunOf('v0.5.10-main.412')).toBe(412)
    for (const tag of [
      'v0.5.9',
      'v0.5.9-rc.3',
      'v0.5.10-main.0',
      '0.5.10-main.4',
      'v0.5.10-main.4+x',
    ]) {
      expect(mainBuildRunOf(tag)).toBeNull()
    }
  })
})

describe('ciPassed', () => {
  it('is true only for a completed, successful ci-result of that commit', () => {
    expect(ciPassed(SHA, { check_runs: [checkRun()] })).toBe(true)
    expect(ciPassed(SHA, { check_runs: [checkRun({ conclusion: 'failure' })] })).toBe(false)
    expect(ciPassed(SHA, { check_runs: [checkRun({ status: 'in_progress' })] })).toBe(false)
    expect(ciPassed(SHA, { check_runs: [checkRun({ head_sha: 'f'.repeat(40) })] })).toBe(false)
    expect(ciPassed(SHA, { check_runs: [checkRun({ name: 'build' })] })).toBe(false)
    expect(ciPassed(SHA, { check_runs: [] })).toBe(false)
    expect(ciPassed(SHA, null)).toBe(false)
  })
})

describe('tagsToPrune', () => {
  it('keeps the ten newest main builds by run number and lists the rest', () => {
    const releases = [99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110].map(mainBuild)
    expect(tagsToPrune(releases)).toEqual(['v0.5.10-main.100', 'v0.5.10-main.99'])
  })

  it('never lists a release, a release candidate or an unflagged main tag', () => {
    const releases = [
      { tagName: 'v0.5.9', isPrerelease: false },
      { tagName: 'v0.5.9-rc.3', isPrerelease: true },
      { tagName: 'v0.5.10-main.1', isPrerelease: false },
      mainBuild(2),
      mainBuild(3),
    ]
    expect(tagsToPrune(releases, 1)).toEqual(['v0.5.10-main.2'])
  })
})

describe('mainBuild.mjs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'main-build-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('prints whether ci-result passed and which tags to prune', () => {
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ check_runs: [checkRun()] }))
    writeFileSync(join(dir, 'releases.json'), JSON.stringify([1, 2, 3].map(mainBuild)))
    expect(run('ci-passed', SHA, join(dir, 'runs.json'))).toBe('true\n')
    expect(run('prune', join(dir, 'releases.json'), '2')).toBe('v0.5.10-main.1\n')
  })

  it('fails on a wrong call', () => {
    expect(() => run('prune', join(dir, 'missing.json'), '0')).toThrow()
    expect(() => run('publish')).toThrow()
  })
})
