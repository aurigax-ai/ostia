import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { RemoteAgent, RemoteJob } from '../shared/remote/remoteSetup'

export interface JobRecord extends RemoteJob {
  token: string
  name?: string
}

export function publicJob({ token: _token, ...job }: JobRecord): RemoteJob & { name?: string } {
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
    if (!job || job.state === state) return
    job.state = state
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
