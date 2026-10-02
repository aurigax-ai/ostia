import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SecretSpan } from '../shared/redaction'

export type SecretScan = (text: string, patterns: string[]) => Promise<SecretSpan[]>

export interface ScanRequest {
  id: number
  text: string
  patterns: string[]
}

export interface ScanReply {
  id: number
  spans?: SecretSpan[]
  error?: string
}

export function redactionWorkerScript(appPath: string): string {
  return join(appPath.replace(/\.asar$/, '.asar.unpacked'), 'out/redaction/worker.js')
}

export const SCAN_BASE_MS = 2000
export const SCAN_PER_MIB_MS = 6000
export const SCAN_MAX_MS = 20_000
const MIB = 1024 * 1024

export function scanDeadline(length: number): number {
  return Math.min(SCAN_MAX_MS, SCAN_BASE_MS + Math.ceil((length / MIB) * SCAN_PER_MIB_MS))
}

interface Job {
  id: number
  text: string
  patterns: string[]
  resolve: (spans: SecretSpan[]) => void
  reject: (error: Error) => void
}

export interface WorkerScan {
  scan: SecretScan
  close: () => Promise<void>
}

export function createWorkerScan(script: string, deadline = scanDeadline): WorkerScan {
  const queue: Job[] = []
  let worker: Worker | null = null
  let current: Job | null = null
  let timer: NodeJS.Timeout | null = null
  let nextId = 0

  const finish = (job: Job, settle: () => void) => {
    if (current !== job) return
    current = null
    if (timer) clearTimeout(timer)
    timer = null
    settle()
    next()
  }

  const drop = (reason: string) => {
    const dead = worker
    worker = null
    if (dead) void dead.terminate()
    if (current) {
      const job = current
      finish(job, () => job.reject(new Error(reason)))
    }
  }

  const spawn = (): Worker => {
    const created = new Worker(script)
    created.unref()
    created.on('message', (reply: ScanReply) => {
      if (worker !== created || !current || current.id !== reply.id) return
      const job = current
      finish(job, () =>
        reply.spans
          ? job.resolve(reply.spans)
          : job.reject(new Error(reply.error ?? 'scan failed')),
      )
    })
    created.on('error', (error) => {
      if (worker === created) drop(error.message)
    })
    created.on('exit', () => {
      if (worker === created) drop('scan worker exited')
    })
    return created
  }

  const next = () => {
    if (current) return
    const job = queue.shift()
    if (!job) return
    current = job
    try {
      worker ??= spawn()
      worker.postMessage({
        id: job.id,
        text: job.text,
        patterns: job.patterns,
      } satisfies ScanRequest)
    } catch (error) {
      drop(error instanceof Error ? error.message : 'scan worker failed')
      return
    }
    timer = setTimeout(() => drop('scan timed out'), deadline(job.text.length))
  }

  return {
    scan: (text, patterns) =>
      new Promise((resolve, reject) => {
        queue.push({ id: nextId++, text, patterns, resolve, reject })
        next()
      }),
    close: async () => {
      const dead = worker
      worker = null
      for (const job of queue.splice(0)) job.reject(new Error('scan closed'))
      if (current) drop('scan closed')
      await dead?.terminate()
    },
  }
}
