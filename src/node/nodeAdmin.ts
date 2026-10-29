import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { ackMail, enqueue, leaseMail } from '../main/agents/busStore'
import { isAgent, type Jobs, publicJob } from './jobs'
import { launchSpec } from './launch'
import type { NodePaths } from './nodePaths'
import type { TmuxHost } from './tmuxHost'

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/
const HEX_RUN = /[0-9a-f]{8}/

export interface AdminDeps {
  paths: NodePaths
  versionDir: string
  version: string
  jobs: Jobs
  tmux: TmuxHost
  shutdown: () => void
}

function folderOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new Error('bad-folder')
  const folder =
    raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(folder) || !statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('bad-folder')
  }
  return folder
}

function nameOf(raw: unknown, jobs: Jobs): string | undefined {
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

export async function reap(deps: AdminDeps): Promise<void> {
  const live = new Set(await deps.tmux.sessions())
  for (const job of deps.jobs.list())
    if (!live.has(job.pane)) deps.jobs.setState(job.pane, 'exited')
}

export function adminMethods(deps: AdminDeps): Record<string, (params: unknown) => unknown> {
  const { paths, jobs, tmux } = deps
  return {
    'node.ping': () => ({ version: deps.version }),

    'node.jobs': async () => {
      await reap(deps)
      return { jobs: jobs.list().map(publicJob) }
    },

    'node.paneNew': async (params) => {
      const input = (params ?? {}) as { agent?: unknown; folder?: unknown; name?: unknown }
      if (!isAgent(input.agent)) throw new Error('bad-agent')
      const folder = folderOf(input.folder)
      const name = nameOf(input.name, jobs)
      const pane = randomBytes(4).toString('hex')
      const token = randomBytes(16).toString('hex')
      mkdirSync(paths.tokens, { recursive: true, mode: 0o700 })
      writeFileAtomic(join(paths.tokens, pane), `${token}\n`, { mode: 0o600 })
      jobs.add({
        pane,
        agent: input.agent,
        folder,
        state: 'idle',
        startedAt: new Date().toISOString(),
        token,
        ...(name ? { name } : {}),
      })
      try {
        await tmux.create(
          launchSpec({
            paths,
            versionDir: deps.versionDir,
            pane,
            agent: input.agent,
            folder,
            env: process.env,
          }),
        )
      } catch (err) {
        jobs.remove(pane)
        rmSync(join(paths.tokens, pane), { force: true })
        throw err
      }
      return { pane }
    },

    'node.stop': async (params) => {
      const { pane } = (params ?? {}) as { pane?: string }
      const job = typeof pane === 'string' ? jobs.resolve(pane) : undefined
      if (!job) throw new Error('unknown-pane')
      await tmux.kill(job.pane).catch(() => {})
      jobs.remove(job.pane)
      rmSync(join(paths.tokens, job.pane), { force: true })
      return { stopped: job.pane }
    },

    'node.selftest': () => {
      const mail = enqueue({ from: 'selftest-a', to: 'selftest-b', text: 'ping' })
      const handed = leaseMail('selftest-b', 'read', (m) => m.id === mail.id)
      const acked = handed ? ackMail('selftest-b', handed.lease) : []
      return { ok: acked.length === 1 }
    },

    'node.shutdown': () => {
      if (jobs.list().some((job) => job.state !== 'exited')) throw new Error('jobs-running')
      setTimeout(deps.shutdown, 50)
      return { ok: true }
    },
  }
}
