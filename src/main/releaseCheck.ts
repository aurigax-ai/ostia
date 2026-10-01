import { BrowserWindow, app, ipcMain } from 'electron'
import { PRODUCT_NAME } from '../shared/product'
import {
  RELEASE_API_BASE_URL,
  RELEASE_REPOSITORY,
  type ReleaseCheckError,
  type ReleaseCheckResult,
  type ReleaseInfo,
  isNewerVersion,
  parseLatestRelease,
  parseVersion,
} from '../shared/releases'
import type { AppLog } from './appLog'
import { loadJson, saveJson, storePath } from './jsonStore'

export const RELEASE_CHECK_STARTUP_DELAY_MS = 5_000
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const RELEASE_CHECK_RETRY_MS = 60 * 60 * 1000
export const RELEASE_REQUEST_TIMEOUT_MS = 10_000
export const RELEASE_RESPONSE_MAX_BYTES = 1024 * 1024
export const RELEASE_API_URL_ENV = 'PINE_RELEASE_API_URL'

export type LatestRelease =
  | { kind: 'release'; release: ReleaseInfo }
  | { kind: 'none' }
  | { kind: 'error'; error: ReleaseCheckError }

export type ReleaseCheckTrigger = 'auto' | 'manual'

export interface ReleaseEndpoint {
  baseUrl: string
  automatic: boolean
}

export function releaseEndpoint(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): ReleaseEndpoint {
  const override = isPackaged ? undefined : env[RELEASE_API_URL_ENV]
  return {
    baseUrl: override || RELEASE_API_BASE_URL,
    automatic: isPackaged || Boolean(override),
  }
}

export function readCheckForUpdates(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return true
  const behavior = (settings as { behavior?: unknown }).behavior
  if (typeof behavior !== 'object' || behavior === null) return true
  return (behavior as { checkForUpdates?: unknown }).checkForUpdates !== false
}

export function releaseUserAgent(version: string): string {
  return `${PRODUCT_NAME}/${version}`
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks).toString('utf8')
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
}

function readRelease(text: string | null): LatestRelease {
  if (text === null) return { kind: 'error', error: 'unavailable' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'error', error: 'unavailable' }
  }
  const parsed = parseLatestRelease(raw)
  if (parsed.ok) return { kind: 'release', release: parsed.release }
  return parsed.reason === 'not-stable' ? { kind: 'none' } : { kind: 'error', error: 'unavailable' }
}

export async function fetchLatestRelease(opts: {
  baseUrl: string
  userAgent: string
  timeoutMs?: number
}): Promise<LatestRelease> {
  const { owner, name } = RELEASE_REPOSITORY
  try {
    const response = await fetch(`${opts.baseUrl}/repos/${owner}/${name}/releases/latest`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/vnd.github+json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? RELEASE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) return { kind: 'none' }
    if (response.status === 403 || response.status === 429) {
      return { kind: 'error', error: 'rate-limited' }
    }
    if (response.status !== 200) return { kind: 'error', error: 'unavailable' }
    return readRelease(await readCapped(response, RELEASE_RESPONSE_MAX_BYTES))
  } catch {
    return { kind: 'error', error: 'offline' }
  }
}

export interface ReleaseChecker {
  check: (trigger: ReleaseCheckTrigger) => Promise<ReleaseCheckResult>
  tick: () => Promise<void>
  available: () => ReleaseInfo | null
  pending: () => ReleaseInfo | null
  dismiss: () => void
}

export function createReleaseChecker(deps: {
  currentVersion: string
  fetchLatest: () => Promise<LatestRelease>
  now: () => number
  enabled: () => boolean
  loadDismissed: () => string | null
  saveDismissed: (version: string) => void
  onChange: (pending: ReleaseInfo | null) => void
  log?: (trigger: ReleaseCheckTrigger, outcome: string, latest: string | undefined) => void
}): ReleaseChecker {
  let available: ReleaseInfo | null = null
  let dismissed = deps.loadDismissed()
  let published: string | null = null
  let nextAutoAt = 0
  let running: Promise<ReleaseCheckResult> | null = null

  const pending = (): ReleaseInfo | null =>
    available && (!dismissed || isNewerVersion(available.version, dismissed)) ? available : null

  const publish = (): void => {
    const next = pending()
    if ((next?.version ?? null) === published) return
    published = next?.version ?? null
    deps.onChange(next)
  }

  const run = async (trigger: ReleaseCheckTrigger): Promise<ReleaseCheckResult> => {
    const latest = await deps.fetchLatest()
    if (latest.kind === 'error') {
      nextAutoAt = deps.now() + RELEASE_CHECK_RETRY_MS
      deps.log?.(trigger, latest.error, undefined)
      return { status: 'error', error: latest.error }
    }
    nextAutoAt = deps.now() + RELEASE_CHECK_INTERVAL_MS
    const newer =
      latest.kind === 'release' && isNewerVersion(latest.release.version, deps.currentVersion)
        ? latest.release
        : null
    available = newer
    publish()
    deps.log?.(
      trigger,
      newer ? 'available' : 'latest',
      latest.kind === 'release' ? latest.release.version : undefined,
    )
    return newer
      ? { status: 'available', release: newer }
      : { status: 'latest', version: deps.currentVersion }
  }

  const check = (trigger: ReleaseCheckTrigger): Promise<ReleaseCheckResult> => {
    running ??= run(trigger).finally(() => {
      running = null
    })
    return running
  }

  return {
    check,
    tick: async () => {
      if (deps.enabled() && deps.now() >= nextAutoAt) await check('auto')
    },
    available: () => available,
    pending,
    dismiss: () => {
      if (!available) return
      dismissed = available.version
      publish()
      deps.saveDismissed(dismissed)
    },
  }
}

const dismissedStorePath = (): string => storePath('release-check', 'global')

function loadDismissed(): string | null {
  const stored = loadJson<{ dismissedVersion?: unknown }>(dismissedStorePath(), {})
  const version = stored?.dismissedVersion
  return typeof version === 'string' && parseVersion(version) ? version : null
}

function announce(pending: ReleaseInfo | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:release-available', pending)
  }
}

export function registerReleaseCheck(deps: {
  openExternal: (url: string) => boolean
  readSettings: () => unknown
  log: AppLog | null
}): void {
  const endpoint = releaseEndpoint(app.isPackaged, process.env)
  const currentVersion = app.getVersion()
  const checker = createReleaseChecker({
    currentVersion,
    fetchLatest: () =>
      fetchLatestRelease({
        baseUrl: endpoint.baseUrl,
        userAgent: releaseUserAgent(currentVersion),
      }),
    now: Date.now,
    enabled: () => readCheckForUpdates(deps.readSettings()),
    loadDismissed,
    saveDismissed: (version) => {
      try {
        saveJson(dismissedStorePath(), { dismissedVersion: version })
      } catch {
        deps.log?.warn('release-dismiss-unsaved')
      }
    },
    onChange: announce,
    log: (trigger, outcome, latest) =>
      deps.log?.info('release-check', { trigger, outcome, latest }),
  })
  if (endpoint.automatic) {
    setTimeout(() => void checker.tick(), RELEASE_CHECK_STARTUP_DELAY_MS).unref()
    setInterval(() => void checker.tick(), RELEASE_CHECK_RETRY_MS).unref()
  }
  ipcMain.handle('app:release-state', () => checker.pending())
  ipcMain.handle('app:release-check', () => checker.check('manual'))
  ipcMain.handle('app:release-dismiss', () => checker.dismiss())
  ipcMain.handle('app:release-open', () => {
    const release = checker.available()
    return release ? deps.openExternal(release.url) : false
  })
}
