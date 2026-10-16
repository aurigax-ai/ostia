import { execFile } from 'node:child_process'
import { hash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { MARKETPLACE_URL_MAX, type MarketplaceError } from '../../../shared/extensions/marketplace'
import { programPath } from '../../platform/systemRequirements'

const GIT_TIMEOUT_MS = 120_000

const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/
const SCP_LIKE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]+$/

export function normalizeMarketplaceUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text || text.length > MARKETPLACE_URL_MAX || text.startsWith('-')) return null
  if (/[\s\p{Cc}]/u.test(text)) return null
  if (isAbsolute(text)) return resolve(text)
  if (GITHUB_SHORTHAND.test(text)) return `https://github.com/${text.replace(/\.git$/, '')}.git`
  if (SCP_LIKE.test(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return url.username || url.password ? null : url.href
  if (url.protocol === 'ssh:') return url.password ? null : url.href
  return null
}

export function marketplaceId(url: string): string {
  return hash('sha256', url).slice(0, 12)
}

export type GitRunner = (args: string[]) => Promise<void>

export class GitError extends Error {
  constructor(
    readonly code: MarketplaceError,
    message: string,
  ) {
    super(message)
  }
}

export const runGit: GitRunner = (args) =>
  new Promise((done, fail) => {
    execFile(
      programPath('git') ?? 'git',
      args,
      {
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, _stdout, stderr) => {
        if (!err) return done()
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        fail(new GitError(missing ? 'git-missing' : 'clone-failed', String(stderr || err.message)))
      },
    )
  })
