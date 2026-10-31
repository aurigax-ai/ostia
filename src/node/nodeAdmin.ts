import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { ackMail, enqueue, leaseMail } from '../main/agents/busStore'
import { jobBranch, jobRef } from '../shared/remote/remoteHandoff'
import type { JobStarter } from './jobStart'
import { isAgent, type Jobs, nameOf, publicJob } from './jobs'
import { exitFileOf, launchSpec } from './launch'
import type { RunnerLink } from './link'
import type { NodePaths } from './nodePaths'
import type { TmuxHost } from './tmuxHost'

const run = promisify(execFile)

const JOB_ID = /^[0-9a-f]{8}$/
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}-[0-9a-f]{12}$/

export interface AdminDeps {
  paths: NodePaths
  versionDir: string
  version: string
  jobs: Jobs
  tmux: TmuxHost
  shutdown: () => void
  link: RunnerLink
  starter: JobStarter
}

async function hasRef(mirror: string, ref: string): Promise<boolean> {
  return run('git', ['-C', mirror, 'rev-parse', '--verify', '--quiet', ref]).then(
    () => true,
    () => false,
  )
}

async function mirrorWith(repos: string, ref: string): Promise<string | undefined> {
  if (!existsSync(repos)) return undefined
  for (const entry of readdirSync(repos)) {
    if (entry.endsWith('.git') && (await hasRef(join(repos, entry), ref))) return entry
  }
  return undefined
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

export async function reap(deps: AdminDeps): Promise<void> {
  const live = new Set(await deps.tmux.sessions())
  for (const job of deps.jobs.list())
    if (!live.has(job.pane)) deps.jobs.setState(job.pane, 'exited')
}

export function adminMethods(
  deps: AdminDeps,
): Record<string, (params: unknown, conn: MessageConnection) => unknown> {
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

    'node.start': (params) => deps.starter.start(params),

    'node.repoInit': async (params) => {
      const { id } = (params ?? {}) as { id?: unknown }
      if (typeof id !== 'string' || !REPO_ID.test(id)) throw new Error('bad-repo')
      const mirror = join(paths.repos, `${id}.git`)
      if (!existsSync(mirror)) {
        mkdirSync(paths.repos, { recursive: true, mode: 0o700 })
        await run('git', ['init', '--bare', '-q', mirror])
      }
      return { path: mirror }
    },

    'node.result': async (params) => {
      const { pane } = (params ?? {}) as { pane?: unknown }
      if (typeof pane !== 'string' || !JOB_ID.test(pane)) throw new Error('unknown-job')
      const branch = jobBranch(pane)
      const repo = await mirrorWith(paths.repos, `refs/heads/${branch}`)
      if (!repo) throw new Error('unknown-job')
      const mirror = join(paths.repos, repo)
      const repoName = repo.slice(0, -'.git'.length)
      const folder = join(paths.work, repoName.slice(0, repoName.lastIndexOf('-')), pane)
      const head = await run('git', ['-C', mirror, 'rev-parse', '--verify', `refs/heads/${branch}`])
      const base = await run('git', ['-C', mirror, 'rev-parse', '--verify', jobRef(pane)])
      const status = existsSync(folder)
        ? await run('git', ['-C', folder, 'status', '--porcelain', '--untracked-files=all'])
        : { stdout: '' }
      return {
        repo: repoName,
        branch,
        base: base.stdout.trim(),
        head: head.stdout.trim(),
        dirty: status.stdout.trim() !== '',
      }
    },

    'node.stop': async (params) => {
      const { pane } = (params ?? {}) as { pane?: string }
      const job = typeof pane === 'string' ? jobs.resolve(pane) : undefined
      if (!job) {
        if (typeof pane === 'string' && JOB_ID.test(pane)) jobs.markStopped(pane)
        return { stopped: typeof pane === 'string' ? pane : '', already: true }
      }
      jobs.markStopped(job.pane)
      await tmux.kill(job.pane).catch(() => {})
      jobs.remove(job.pane)
      rmSync(join(paths.tokens, job.pane), { force: true })
      rmSync(exitFileOf(paths, job.pane), { force: true })
      return { stopped: job.pane }
    },

    'node.selftest': () => {
      const mail = enqueue({ from: 'selftest-a', to: 'selftest-b', text: 'ping' })
      const handed = leaseMail('selftest-b', 'read', (m) => m.id === mail.id)
      const acked = handed ? ackMail('selftest-b', handed.lease) : []
      return { ok: acked.length === 1 }
    },

    'node.link': (_params, conn) => {
      deps.link.attach(conn)
      return { ok: true }
    },

    'node.shutdown': () => {
      if (jobs.list().some((job) => job.state !== 'exited')) throw new Error('jobs-running')
      setTimeout(deps.shutdown, 50)
      return { ok: true }
    },
  }
}
