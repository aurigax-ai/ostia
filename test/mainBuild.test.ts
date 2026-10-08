import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mainBuildRunOf, tagsToPrune } from '../scripts/mainBuild.mjs'

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
  let server: Server | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'main-build-'))
  })

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true })
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
    server = undefined
  })

  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  async function ciPassed(checkRuns: unknown[], status = 200): Promise<string> {
    const asked: string[] = []
    server = createServer((req, res) => {
      asked.push(req.url ?? '')
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ check_runs: checkRuns }))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, 'ci-passed', SHA], {
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_API_URL: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`,
        GITHUB_REPOSITORY: 'aurigax-ai/ostia',
        GH_TOKEN: 'test-token',
      },
    })
    expect(asked).toEqual([
      `/repos/aurigax-ai/ostia/commits/${SHA}/check-runs?check_name=ci-result&filter=latest&per_page=100`,
    ])
    return stdout
  }

  it('prints true only when ci-result passed for that commit', async () => {
    expect(await ciPassed([checkRun()])).toBe('true\n')
    for (const other of [
      checkRun({ conclusion: 'failure' }),
      checkRun({ status: 'in_progress' }),
      checkRun({ head_sha: 'f'.repeat(40) }),
      checkRun({ name: 'build' }),
    ]) {
      await new Promise((resolve) => server?.close(resolve))
      expect(await ciPassed([other])).toBe('false\n')
    }
  })

  it('fails when GitHub cannot be asked', async () => {
    await expect(ciPassed([checkRun()], 500)).rejects.toThrow(/HTTP 500/)
    expect(() => run('ci-passed', SHA)).toThrow(/GH_TOKEN/)
  })

  it('prints which tags to prune', () => {
    writeFileSync(join(dir, 'releases.json'), JSON.stringify([1, 2, 3].map(mainBuild)))
    expect(run('prune', join(dir, 'releases.json'), '2')).toBe('v0.5.10-main.1\n')
  })

  it('fails on a wrong call', () => {
    expect(() => run('prune', join(dir, 'missing.json'), '0')).toThrow()
    expect(() => run('publish')).toThrow()
  })
})
