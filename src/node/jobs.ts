import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { RemoteAgent, RemoteJob } from '../shared/remote/remoteSetup'

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/
const HEX_RUN = /[0-9a-f]{8}/

export interface JobRecord extends RemoteJob {
  token: string
  name?: string
  repo?: string
  started?: true
  session?: string
}

export function publicJob({
  token: _token,
  started: _started,
  ...job
}: JobRecord): RemoteJob & { name?: string } {
  return job
}

function read(file: string): JobRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { jobs?: JobRecord[] }
    return Array.isArray(parsed.jobs) ? parsed.jobs : []
  } catch {
    return []
  }
}

export class Jobs {
  private jobs: JobRecord[]

  constructor(private readonly file: string) {
    this.jobs = read(file)
  }

  private save(): void {
    writeFileAtomic(this.file, `${JSON.stringify({ jobs: this.jobs }, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  list(): JobRecord[] {
    return this.jobs
  }

  get(pane: string): JobRecord | undefined {
    return this.jobs.find((job) => job.pane === pane)
  }

  resolve(ref: string): JobRecord | undefined {
    return this.get(ref) ?? this.jobs.find((job) => job.name === ref)
  }

  byToken(token: string): JobRecord | undefined {
    return this.jobs.find((job) => job.token === token)
  }

  add(job: JobRecord): void {
    this.jobs.push(job)
    this.save()
  }

  setState(pane: string, state: RemoteJob['state']): void {
    const job = this.get(pane)
    if (!job) return
    if (!job.started && state !== 'exited') job.started = true
    if (job.state === state && job.started) return
    job.state = state
    this.save()
  }

  markStarted(pane: string, session?: string): void {
    const job = this.get(pane)
    if (!job) return
    job.started = true
    if (session) job.session = session
    if (job.state === 'starting') job.state = 'idle'
    this.save()
  }

  remove(pane: string): void {
    this.jobs = this.jobs.filter((job) => job.pane !== pane)
    this.save()
  }
}

export function isAgent(value: unknown): value is RemoteAgent | 'shell' {
  return value === 'claude' || value === 'codex' || value === 'shell'
}

export function nameOf(raw: unknown, jobs: Jobs): string | undefined {
  if (raw === undefined) return undefined
  if (
    typeof raw !== 'string' ||
    !NAME_PATTERN.test(raw) ||
    HEX_RUN.test(raw) ||
    jobs.resolve(raw)
  ) {
    throw new Error('bad-name')
  }
  return raw
}
