import { spawn } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { githubRequest } from '../scripts/github.mjs'
import {
  fromMergeQueue,
  mergeQueueVerified,
  passingCheckRuns,
} from '../scripts/mergeQueueVerified.mjs'

const QUEUED = 'd7d6db2f560229386c9e4aa14764982926f3a6db'
const DIRECT = '42f8723c403c5fd93046d5ba89874bc72cf514b4'
const QUEUE_BRANCH = 'gh-readonly-queue/main/pr-414-e73efe677defa47ddc944ddf1aee4c9641eaa1bf'
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'mergeQueueVerified.mjs')

type Json = Record<string, unknown>

function checkRun(sha: string, suite: number, overrides: Json = {}): Json {
  return {
    id: suite + 1,
    name: 'ci-result',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
    check_suite: { id: suite },
    html_url: `https://github.com/aurigax-ai/ostia/runs/${suite + 1}`,
    ...overrides,
  }
}

function suite(sha: string, id: number, headBranch: string, overrides: Json = {}): Json {
  return {
    id,
    head_sha: sha,
    head_branch: headBranch,
    app: { slug: 'github-actions' },
    ...overrides,
  }
}

function workflowRun(sha: string, headBranch: string, event: string, overrides: Json = {}): Json {
  return {
    head_sha: sha,
    head_branch: headBranch,
    event,
    path: '.github/workflows/ci.yml',
    ...overrides,
  }
}

function queuedResponses(): Record<string, Json> {
  return {
    [`commits/${QUEUED}/check-runs?check_name=ci-result&filter=latest&per_page=100`]: {
      total_count: 1,
      check_runs: [checkRun(QUEUED, 101990543425)],
    },
    'check-suites/101990543425': suite(QUEUED, 101990543425, QUEUE_BRANCH),
    'actions/runs?check_suite_id=101990543425&per_page=100': {
      total_count: 1,
      workflow_runs: [workflowRun(QUEUED, QUEUE_BRANCH, 'merge_group')],
    },
  }
}

function directResponses(): Record<string, Json> {
  return {
    [`commits/${DIRECT}/check-runs?check_name=ci-result&filter=latest&per_page=100`]: {
      total_count: 1,
      check_runs: [checkRun(DIRECT, 101979855094)],
    },
    'check-suites/101979855094': suite(DIRECT, 101979855094, 'main'),
    'actions/runs?check_suite_id=101979855094&per_page=100': {
      total_count: 1,
      workflow_runs: [workflowRun(DIRECT, 'main', 'push')],
    },
  }
}

function requestFrom(responses: Record<string, Json>) {
  const seen: string[] = []
  const request = async (path: string) => {
    seen.push(path)
    if (!(path in responses)) throw new Error(`GET ${path} returned HTTP 404`)
    return responses[path]
  }
  return { request, seen }
}

describe('mergeQueueVerified', () => {
  it('verifies a sha whose ci-result passed in a merge queue run (#414, d7d6db2f)', async () => {
    const { request } = requestFrom(queuedResponses())
    const result = await mergeQueueVerified(QUEUED, request)
    expect(result.verified).toBe(true)
    expect(result.reason).toContain(QUEUE_BRANCH)
  })

  it('does not verify a sha pushed straight to main, even with a green ci-result (42f8723c)', async () => {
    const { request } = requestFrom(directResponses())
    const result = await mergeQueueVerified(DIRECT, request)
    expect(result.verified).toBe(false)
    expect(result.reason).toMatch(/not in a merge queue run/)
  })

  it('does not verify when there is no ci-result check run', async () => {
    const responses = queuedResponses()
    responses[`commits/${QUEUED}/check-runs?check_name=ci-result&filter=latest&per_page=100`] = {
      total_count: 0,
      check_runs: [],
    }
    const { request, seen } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: false })
    expect(seen).toHaveLength(1)
  })

  it.each([
    ['failed', { conclusion: 'failure' }],
    ['cancelled', { conclusion: 'cancelled' }],
    ['still running', { status: 'in_progress', conclusion: null }],
    ['made by another app', { app: { slug: 'some-bot' } }],
    ['for another sha', { head_sha: DIRECT }],
    ['under another name', { name: 'ci / ci-result' }],
  ])('does not verify when the merge queue ci-result is %s', async (_label, overrides) => {
    const responses = queuedResponses()
    responses[`commits/${QUEUED}/check-runs?check_name=ci-result&filter=latest&per_page=100`] = {
      total_count: 1,
      check_runs: [checkRun(QUEUED, 101990543425, overrides)],
    }
    const { request } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: false })
  })

  it.each([
    ['main', 'main'],
    ['a pull request branch', 'issue/387'],
    ['the queue of another base branch', 'gh-readonly-queue/release/pr-1-abc'],
    ['a name that only contains the prefix', 'x/gh-readonly-queue/main/pr-1'],
  ])('does not verify when the check suite head branch is %s', async (_label, branch) => {
    const responses = queuedResponses()
    responses['check-suites/101990543425'] = suite(QUEUED, 101990543425, branch)
    responses['actions/runs?check_suite_id=101990543425&per_page=100'] = {
      workflow_runs: [workflowRun(QUEUED, branch, 'merge_group')],
    }
    const { request } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: false })
  })

  it('does not verify when the check suite has no head branch', async () => {
    const responses = queuedResponses()
    responses['check-suites/101990543425'] = suite(QUEUED, 101990543425, '', {
      head_branch: null,
    })
    const { request } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: false })
  })

  it.each([
    ['a pull_request event', { event: 'pull_request' }],
    ['another workflow file', { path: '.github/workflows/release.yml' }],
    ['another sha', { head_sha: DIRECT }],
  ])('does not verify when the queue branch run is %s', async (_label, overrides) => {
    const responses = queuedResponses()
    responses['actions/runs?check_suite_id=101990543425&per_page=100'] = {
      workflow_runs: [workflowRun(QUEUED, QUEUE_BRANCH, 'merge_group', overrides)],
    }
    const { request } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: false })
  })

  it('verifies when one of several passing ci-result runs came from the merge queue', async () => {
    const responses = {
      ...queuedResponses(),
      [`commits/${QUEUED}/check-runs?check_name=ci-result&filter=latest&per_page=100`]: {
        total_count: 2,
        check_runs: [checkRun(QUEUED, 7), checkRun(QUEUED, 101990543425)],
      },
      'check-suites/7': suite(QUEUED, 7, 'main'),
      'actions/runs?check_suite_id=7&per_page=100': {
        workflow_runs: [workflowRun(QUEUED, 'main', 'push')],
      },
    }
    const { request } = requestFrom(responses)
    expect(await mergeQueueVerified(QUEUED, request)).toMatchObject({ verified: true })
  })

  it.each([
    [
      'the check runs',
      `commits/${QUEUED}/check-runs?check_name=ci-result&filter=latest&per_page=100`,
    ],
    ['the check suite', 'check-suites/101990543425'],
    ['the workflow run', 'actions/runs?check_suite_id=101990543425&per_page=100'],
  ])('treats an API error on %s as not verified', async (_label, failing) => {
    const responses = queuedResponses()
    const request = async (path: string) => {
      if (path === failing) throw new Error(`GET ${path} returned HTTP 502`)
      return responses[path]
    }
    const result = await mergeQueueVerified(QUEUED, request)
    expect(result.verified).toBe(false)
    expect(result.reason).toMatch(/HTTP 502/)
  })

  it('treats a malformed API response as not verified', async () => {
    const result = await mergeQueueVerified(QUEUED, async () => null)
    expect(result.verified).toBe(false)
  })

  it.each([['d7d6db2f'], [''], [undefined], [`${QUEUED}\n`], ['refs/heads/main']])(
    'refuses anything but a full sha (%j) without calling the API',
    async (sha) => {
      const { request, seen } = requestFrom(queuedResponses())
      expect(await mergeQueueVerified(sha as string, request)).toMatchObject({ verified: false })
      expect(seen).toEqual([])
    },
  )
})

describe('passingCheckRuns and fromMergeQueue', () => {
  it('keeps only completed, successful ci-result runs by GitHub Actions for the sha', () => {
    const runs = [
      checkRun(QUEUED, 1),
      checkRun(QUEUED, 2, { conclusion: 'failure' }),
      checkRun(QUEUED, 3, { check_suite: null }),
      null,
    ]
    expect(passingCheckRuns(QUEUED, runs).map((run: Json) => run.id)).toEqual([2])
    expect(passingCheckRuns(QUEUED, undefined)).toEqual([])
  })

  it('needs the suite and a merge_group run of ci.yml on the same queue branch', () => {
    const queueSuite = suite(QUEUED, 1, QUEUE_BRANCH)
    const run = workflowRun(QUEUED, QUEUE_BRANCH, 'merge_group')
    expect(fromMergeQueue(QUEUED, queueSuite, [run])).toBe(true)
    expect(fromMergeQueue(QUEUED, queueSuite, [])).toBe(false)
    expect(fromMergeQueue(QUEUED, queueSuite, [{ ...run, head_branch: `${QUEUE_BRANCH}x` }])).toBe(
      false,
    )
    expect(fromMergeQueue(QUEUED, { ...queueSuite, head_sha: DIRECT }, [run])).toBe(false)
    expect(fromMergeQueue(QUEUED, { ...queueSuite, app: { slug: 'x' } }, [run])).toBe(false)
    expect(fromMergeQueue(QUEUED, null, [run])).toBe(false)
  })
})

describe('githubRequest', () => {
  it('needs the API URL, repository and token', () => {
    expect(() => githubRequest({ api: '', repository: 'a/b', token: 't' })).toThrow(/GH_TOKEN/)
    expect(() =>
      githubRequest({ api: 'https://api.github.com', repository: 'a/b', token: '' }),
    ).toThrow(/GH_TOKEN/)
  })

  it('calls the repository API with the token and returns the parsed body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const request = githubRequest({
      api: 'https://api.github.com/',
      repository: 'aurigax-ai/ostia',
      token: 'test-token',
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
      },
    })
    expect(await request('check-suites/1')).toEqual({ ok: 1 })
    expect(calls[0].url).toBe('https://api.github.com/repos/aurigax-ai/ostia/check-suites/1')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    )
  })

  it('throws on a non-2xx status', async () => {
    const request = githubRequest({
      api: 'https://api.github.com',
      repository: 'aurigax-ai/ostia',
      token: 'test-token',
      fetchImpl: async () => new Response('{}', { status: 403 }),
    })
    await expect(request('check-suites/1')).rejects.toThrow(/HTTP 403/)
  })
})

describe('the CLI', () => {
  let server: Server | undefined

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
    server = undefined
  })

  async function serve(responses: Record<string, Json>, status = 200): Promise<string> {
    server = createServer((req, res) => {
      const path = (req.url ?? '').replace(/^\/repos\/aurigax-ai\/ostia\//, '')
      const body = responses[path]
      const code = status !== 200 ? status : body ? 200 : 404
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body ?? {}))
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
  }

  function cli(args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        env: { PATH: process.env.PATH ?? '', ...env },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  const env = (api: string) => ({
    GITHUB_API_URL: api,
    GITHUB_REPOSITORY: 'aurigax-ai/ostia',
    GH_TOKEN: 'test-token',
  })

  it('prints true for a merge queue sha and false for a direct push', async () => {
    const api = await serve({ ...queuedResponses(), ...directResponses() })
    expect(await cli([QUEUED], env(api))).toMatchObject({ code: 0, stdout: 'true\n' })
    expect(await cli([DIRECT], env(api))).toMatchObject({ code: 0, stdout: 'false\n' })
  })

  it('prints false and exits 0 when the API fails, so CI runs every job', async () => {
    const api = await serve(queuedResponses(), 500)
    const result = await cli([QUEUED], env(api))
    expect(result).toMatchObject({ code: 0, stdout: 'false\n' })
    expect(result.stderr).toMatch(/HTTP 500/)
  })

  it('prints false and exits 0 without a token or with the wrong arguments', async () => {
    const api = await serve(queuedResponses())
    expect(await cli([QUEUED], { ...env(api), GH_TOKEN: '' })).toMatchObject({
      code: 0,
      stdout: 'false\n',
    })
    expect(await cli([], env(api))).toMatchObject({ code: 0, stdout: 'false\n' })
  })

  it('prints false when the API cannot be reached', async () => {
    const api = await serve({})
    await new Promise((resolve) => server?.close(resolve))
    server = undefined
    expect(await cli([QUEUED], env(api))).toMatchObject({ code: 0, stdout: 'false\n' })
  })
})
