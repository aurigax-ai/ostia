export type BrowserProfile = 'shared' | 'isolated'

export type BrowserOpener = 'human' | 'agent'

export const SHARED_BROWSER_PARTITION = 'persist:pine-browser'

const ISOLATED_PREFIX = 'pine-browser-'

export function isolatedBrowserPartition(paneId: string): string {
  return `${ISOLATED_PREFIX}${paneId}`
}

export function browserPartition(profile: BrowserProfile, paneId: string): string {
  return profile === 'shared' ? SHARED_BROWSER_PARTITION : isolatedBrowserPartition(paneId)
}

export function isIsolatedBrowserPartition(partition: string | undefined): boolean {
  return typeof partition === 'string' && partition.startsWith(ISOLATED_PREFIX)
}

export function parseBrowserProfile(raw: unknown): BrowserProfile {
  return raw === 'shared' ? 'shared' : 'isolated'
}

export interface BrowserProfileContext {
  opener: BrowserOpener
  scratch: boolean
  sandboxed: boolean
}

export function browserProfileFor(ctx: BrowserProfileContext): BrowserProfile {
  if (ctx.opener !== 'human' || ctx.scratch || ctx.sandboxed) return 'isolated'
  return 'shared'
}
