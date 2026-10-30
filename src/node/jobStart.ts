import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import {
  isRepoHandoff,
  type JobOutcome,
  jobBranch,
  jobRef,
  PROMPT_MAX,
  type RepoHandoff,
  START_WAIT_MS,
} from '../shared/remote/remoteHandoff'
import type { RemoteAgent } from '../shared/remote/remoteSetup'
import type { JobRecord, Jobs } from './jobs'
import { exitFileOf, launchSpec } from './launch'
import type { NodePaths } from './nodePaths'
import type { TmuxHost } from './tmuxHost'

const run = promisify(execFile)

const JOB_ID = /^[0-9a-f]{8}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/
const POLL_MS = 100

interface StartRequest {
  jobId: string
  agent: RemoteAgent
  prompt: string
  model?: string
  repo: RepoHandoff
}

export interface StarterDeps {
  paths: NodePaths
  versionDir: string
  jobs: Jobs
  tmux: TmuxHost
  waitMs?: number
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trim()
}

function parseStart(raw: unknown): StartRequest {
  const input = (raw ?? {}) as Record<string, unknown>
  const { jobId, agent, prompt, model, repo } = input
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('bad-job-id')
  if (agent !== 'claude' && agent !== 'codex') throw new Error('bad-agent')
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > PROMPT_MAX) {
    throw new Error('bad-prompt')
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL.test(model))) {
    throw new Error('bad-model')
  }
  if (!isRepoHandoff(repo)) throw new Error('bad-repo')
  return { jobId, agent, prompt, repo, ...(typeof model === 'string' ? { model } : {}) }
}

export class JobStarter {
  private readonly inflight = new Map<string, Promise<JobOutcome>>()

  constructor(private readonly deps: StarterDeps) {}

  start(raw: unknown): Promise<JobOutcome> {
    const request = parseStart(raw)
    const running = this.inflight.get(request.jobId)
    if (running) return running
    if (this.deps.jobs.isStopped(request.jobId) && !this.deps.jobs.get(request.jobId)) {
      return Promise.resolve({
        status: 'failed',
        jobId: request.jobId,
        reason: 'the job was stopped',
      })
    }
    const done = this.begin(request).finally(() => this.inflight.delete(request.jobId))
    this.inflight.set(request.jobId, done)
    return done
  }

  private async begin(request: StartRequest): Promise<JobOutcome> {
    if (!this.deps.jobs.get(request.jobId)) await this.create(request)
    return this.outcome(request.jobId)
  }

  private async create(request: StartRequest): Promise<void> {
    const { paths, jobs, tmux } = this.deps
    const { jobId, repo } = request
    const mirror = join(paths.repos, `${repo.id}.git`)
    const pushed = await git(['-C', mirror, 'rev-parse', '--verify', `${jobRef(jobId)}^{commit}`])
    if (pushed !== repo.head) throw new Error('ref-missing')
    const folder = join(paths.work, repo.name, jobId)
    if (!existsSync(folder)) {
      mkdirSync(dirname(folder), { recursive: true })
      await git(['-C', mirror, 'worktree', 'add', '-B', jobBranch(jobId), folder, jobRef(jobId)])
    }
    const token = randomBytes(16).toString('hex')
    mkdirSync(paths.tokens, { recursive: true, mode: 0o700 })
    writeFileAtomic(join(paths.tokens, jobId), `${token}\n`, { mode: 0o600 })
    const record: JobRecord = {
      pane: jobId,
      agent: request.agent,
      folder,
      state: 'starting',
      startedAt: new Date().toISOString(),
      token,
      repo: repo.id,
    }
    jobs.add(record)
    try {
      await tmux.create(
        launchSpec({
          paths,
          versionDir: this.deps.versionDir,
          pane: jobId,
          agent: request.agent,
          folder,
          env: process.env,
          prompt: request.prompt,
          ...(request.model ? { model: request.model } : {}),
        }),
      )
    } catch (err) {
      jobs.remove(jobId)
      rmSync(join(paths.tokens, jobId), { force: true })
      throw err
    }
  }

  private exitOf(pane: string): string | undefined {
    try {
      return readFileSync(exitFileOf(this.deps.paths, pane), 'utf8').trim()
    } catch {
      return undefined
    }
  }

  private async outcome(jobId: string): Promise<JobOutcome> {
    const { jobs, tmux } = this.deps
    const until = Date.now() + (this.deps.waitMs ?? START_WAIT_MS)
    for (;;) {
      const job = jobs.get(jobId)
      if (!job) return { status: 'failed', jobId, reason: 'the job was stopped' }
      if (job.started) {
        return {
          status: 'started',
          jobId,
          pane: job.pane,
          ...(job.session ? { session: job.session } : {}),
        }
      }
      const exit = this.exitOf(job.pane)
      if (exit !== undefined || !(await tmux.sessions()).includes(job.pane)) {
        jobs.setState(job.pane, 'exited')
        const code = exit ? ` with exit code ${exit}` : ''
        return { status: 'failed', jobId, reason: `the agent ended${code} before it started` }
      }
      if (Date.now() >= until) {
        return { status: 'failed', jobId, reason: 'the agent did not report its start' }
      }
      await sleep(POLL_MS)
    }
  }
}
