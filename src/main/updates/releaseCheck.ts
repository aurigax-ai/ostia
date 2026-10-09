import { BrowserWindow, app, ipcMain } from 'electron'
import { releaseVersion } from '../../shared/app/buildInfo'
import {
  type InstallMethod,
  type ReleaseState,
  type ReplaceAvailability,
  type ReplaceProgress,
  type ReplaceState,
  type UpdateRunState,
  updateChannelFor,
  updateCommandLine,
} from '../../shared/app/installMethod'
import {
  type ParsedRelease,
  RELEASE_API_BASE_URL,
  RELEASE_REPOSITORY,
  type ReleaseCheckError,
  type ReleaseCheckResult,
  type ReleaseInfo,
  type UpdateChannel,
  isNewerVersion,
  parseLatestRelease,
  parseUpdateChannel,
  parseVersion,
  pickMainChannelRelease,
} from '../../shared/app/releases'
import { readEnv } from '../../shared/appEnv'
import { PRODUCT_NAME } from '../../shared/product'
import type { AppLog } from '../diagnostics/appLog'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import type { InstallReplacer } from './installReplace'
import type { UpdateRunner } from './updateRun'

export const RELEASE_CHECK_STARTUP_DELAY_MS = 5_000
export const RELEASE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const RELEASE_CHECK_RETRY_MS = 60 * 60 * 1000
export const RELEASE_REQUEST_TIMEOUT_MS = 10_000
export const RELEASE_RESPONSE_MAX_BYTES = 1024 * 1024
export const RELEASE_API_URL_ENV = 'RELEASE_API_URL'
const MAIN_CHANNEL_PAGE_SIZE = 30

export type LatestRelease =
  | { kind: 'release'; release: ReleaseInfo }
  | { kind: 'none' }
  | { kind: 'error'; error: ReleaseCheckError }

export type ReleaseCheckTrigger = 'auto' | 'manual'

interface ReleaseEndpoint {
  baseUrl: string
  automatic: boolean
}

export function releaseEndpoint(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): ReleaseEndpoint {
  const override = isPackaged ? undefined : readEnv(RELEASE_API_URL_ENV, env)
  return {
    baseUrl: override || RELEASE_API_BASE_URL,
    automatic: isPackaged || Boolean(override),
  }
}

function readBehavior(settings: unknown): Record<string, unknown> {
  if (typeof settings !== 'object' || settings === null) return {}
  const behavior = (settings as { behavior?: unknown }).behavior
  return typeof behavior === 'object' && behavior !== null
    ? (behavior as Record<string, unknown>)
    : {}
}

export function readCheckForUpdates(settings: unknown): boolean {
  return readBehavior(settings).checkForUpdates !== false
}

export function readUpdateChannel(settings: unknown): UpdateChannel {
  return parseUpdateChannel(readBehavior(settings).updateChannel)
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

function readRelease(text: string | null, parse: (raw: unknown) => ParsedRelease): LatestRelease {
  if (text === null) return { kind: 'error', error: 'unavailable' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'error', error: 'unavailable' }
  }
  const parsed = parse(raw)
  if (parsed.ok) return { kind: 'release', release: parsed.release }
  return parsed.reason === 'not-stable' ? { kind: 'none' } : { kind: 'error', error: 'unavailable' }
}

function releaseQuery(channel: UpdateChannel): {
  path: string
  parse: (raw: unknown) => ParsedRelease
} {
  return channel === 'main'
    ? { path: `releases?per_page=${MAIN_CHANNEL_PAGE_SIZE}`, parse: pickMainChannelRelease }
    : { path: 'releases/latest', parse: parseLatestRelease }
}

export async function fetchLatestRelease(opts: {
  baseUrl: string
  userAgent: string
  channel: UpdateChannel
  timeoutMs?: number
}): Promise<LatestRelease> {
  const { owner, name } = RELEASE_REPOSITORY
  const query = releaseQuery(opts.channel)
  try {
    const response = await fetch(`${opts.baseUrl}/repos/${owner}/${name}/${query.path}`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/vnd.github+json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? RELEASE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) return { kind: 'none' }
    if (response.status === 403 || response.status === 429) {
      return { kind: 'error', error: 'rate-limited' }
    }
    if (response.status !== 200) return { kind: 'error', error: 'unavailable' }
    return readRelease(await readCapped(response, RELEASE_RESPONSE_MAX_BYTES), query.parse)
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
  settingsChanged: () => Promise<void>
}

export function createReleaseChecker(deps: {
  currentVersion: string
  fetchLatest: (channel: UpdateChannel) => Promise<LatestRelease>
  now: () => number
  enabled: () => boolean
  channel: () => UpdateChannel
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
  let channel = deps.channel()

  const pending = (): ReleaseInfo | null =>
    available && (!dismissed || isNewerVersion(available.version, dismissed)) ? available : null

  const publish = (): void => {
    const next = pending()
    if ((next?.version ?? null) === published) return
    published = next?.version ?? null
    deps.onChange(next)
  }

  const run = async (trigger: ReleaseCheckTrigger): Promise<ReleaseCheckResult> => {
    channel = deps.channel()
    const latest = await deps.fetchLatest(channel)
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

  const tick = async (): Promise<void> => {
    if (deps.enabled() && deps.now() >= nextAutoAt) await check('auto')
  }

  return {
    check,
    tick,
    available: () => available,
    pending,
    dismiss: () => {
      if (!available) return
      dismissed = available.version
      publish()
      deps.saveDismissed(dismissed)
    },
    settingsChanged: async () => {
      if (deps.channel() === channel) return
      channel = deps.channel()
      available = null
      nextAutoAt = 0
      publish()
      await tick()
    },
  }
}

const dismissedStorePath = (): string => storePath('release-check', 'global')

function loadDismissed(): string | null {
  const stored = loadJson<{ dismissedVersion?: unknown }>(dismissedStorePath(), {})
  const version = stored?.dismissedVersion
  return typeof version === 'string' && parseVersion(version) ? version : null
}

function releaseState(
  release: ReleaseInfo | null,
  method: InstallMethod,
  replace: ReplaceAvailability | null,
): ReleaseState {
  return { release, method, updateCommand: updateCommandLine(method), replace }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function announceUpdateRun(state: UpdateRunState): void {
  broadcast('app:update-run-state', state)
}

export function announceReplace(state: ReplaceState): void {
  broadcast('app:install-replace-state', state)
}

export function announceReplaceProgress(progress: ReplaceProgress): void {
  broadcast('app:update-progress', progress)
}

export function registerReleaseCheck(deps: {
  openExternal: (url: string) => boolean
  readSettings: () => unknown
  log: AppLog | null
  version: string
  method: () => InstallMethod
  updateRunner: UpdateRunner
  replaceAvailability: () => Promise<ReplaceAvailability | null>
  replacer: InstallReplacer
}): { settingsChanged: () => void } {
  const stateOf = async (pending: ReleaseInfo | null): Promise<ReleaseState> =>
    releaseState(pending, deps.method(), pending ? await deps.replaceAvailability() : null)
  const endpoint = releaseEndpoint(app.isPackaged, process.env)
  const currentVersion = releaseVersion(deps.version)
  const checker = createReleaseChecker({
    currentVersion,
    fetchLatest: (channel) =>
      fetchLatestRelease({
        baseUrl: endpoint.baseUrl,
        userAgent: releaseUserAgent(currentVersion),
        channel,
      }),
    now: Date.now,
    enabled: () => readCheckForUpdates(deps.readSettings()),
    channel: () => updateChannelFor(deps.method(), readUpdateChannel(deps.readSettings())),
    loadDismissed,
    saveDismissed: (version) => {
      try {
        saveJson(dismissedStorePath(), { dismissedVersion: version })
      } catch {
        deps.log?.warn('release-dismiss-unsaved')
      }
    },
    onChange: (pending) => {
      void stateOf(pending).then((state) => broadcast('app:release-available', state))
    },
    log: (trigger, outcome, latest) =>
      deps.log?.info('release-check', { trigger, outcome, latest }),
  })
  if (endpoint.automatic) {
    setTimeout(() => void checker.tick(), RELEASE_CHECK_STARTUP_DELAY_MS).unref()
    setInterval(() => void checker.tick(), RELEASE_CHECK_RETRY_MS).unref()
  }
  ipcMain.handle('app:release-state', () => stateOf(checker.pending()))
  ipcMain.handle('app:install-replace', () => {
    const release = checker.available()
    return release ? deps.replacer.start(release.version) : 'no-action'
  })
  ipcMain.handle('app:install-replace-state', () => deps.replacer.state())
  ipcMain.handle('app:update-run', () => deps.updateRunner.start())
  ipcMain.handle('app:update-run-state', () => deps.updateRunner.state())
  ipcMain.handle('app:release-check', () => checker.check('manual'))
  ipcMain.handle('app:release-dismiss', () => checker.dismiss())
  ipcMain.handle('app:release-open', () => {
    const release = checker.available()
    return release ? deps.openExternal(release.url) : false
  })
  return { settingsChanged: () => void checker.settingsChanged() }
}
