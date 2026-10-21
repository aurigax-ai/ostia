import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app, ipcMain } from 'electron'
import { releaseVersion } from '../../shared/app/buildInfo'
import {
  type InstallMethod,
  isMacInstall,
  type ReleaseState,
  type ReplaceAvailability,
  updateChannelFor,
  updateCommandLine,
} from '../../shared/app/installMethod'
import {
  type AssetName,
  dmgAssetName,
  isNewerVersion,
  type ParsedRelease,
  parseLatestRelease,
  parseUpdateChannel,
  parseVersion,
  pickBetaRelease,
  pickMainChannelRelease,
  RELEASE_API_BASE_URL,
  RELEASE_REPOSITORY,
  type ReleaseCheckError,
  type ReleaseCheckResult,
  type ReleaseInfo,
  tarballAssetName,
  type UpdateChannel,
} from '../../shared/app/releases'
import type { AppLog } from '../diagnostics/appLog'
import { readCapped } from '../platform/checkedDownload'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'
import type { InstallReplacer } from './installReplace'
import type { UpdateRunner } from './updateRun'

const RELEASE_CHECK_STARTUP_DELAY_MS = 5_000
export const RELEASE_CHECK_INTERVAL_MS = 60 * 60 * 1000
export const RELEASE_CHECK_RETRY_MS = 60 * 60 * 1000
const RELEASE_CHECK_TICK_MS = 60 * 1000
const RELEASE_REQUEST_TIMEOUT_MS = 10_000
const RELEASE_RESPONSE_MAX_BYTES = 1024 * 1024
export const RELEASE_API_URL_ENV = 'RELEASE_API_URL'
const RELEASE_LIST_PAGE_SIZE = 30
const RELEASE_LIST_MAX_PAGES = 4

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

function releaseQuery(
  channel: UpdateChannel,
  betaAsset: AssetName,
): {
  path: string
  parse: (raw: unknown) => ParsedRelease
} {
  const list = `releases?per_page=${RELEASE_LIST_PAGE_SIZE}`
  if (channel === 'main') return { path: list, parse: pickMainChannelRelease }
  if (channel === 'beta') return { path: list, parse: (raw) => pickBetaRelease(raw, betaAsset) }
  return { path: 'releases/latest', parse: parseLatestRelease }
}

type PageText = { kind: 'text'; text: string } | { kind: 'done'; result: LatestRelease }

async function fetchPage(
  opts: { baseUrl: string; userAgent: string; timeoutMs?: number },
  path: string,
): Promise<PageText> {
  const { owner, name } = RELEASE_REPOSITORY
  try {
    const response = await fetch(`${opts.baseUrl}/repos/${owner}/${name}/${path}`, {
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/vnd.github+json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? RELEASE_REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) return { kind: 'done', result: { kind: 'none' } }
    if (response.status === 403 || response.status === 429) {
      return { kind: 'done', result: { kind: 'error', error: 'rate-limited' } }
    }
    if (response.status !== 200 || !response.body) {
      return { kind: 'done', result: { kind: 'error', error: 'unavailable' } }
    }
    const text = await readCapped(response.body, RELEASE_RESPONSE_MAX_BYTES)
    return { kind: 'text', text: text ?? '' }
  } catch {
    return { kind: 'done', result: { kind: 'error', error: 'offline' } }
  }
}

function isFullPage(text: string): boolean {
  try {
    const list: unknown = JSON.parse(text)
    return Array.isArray(list) && list.length >= RELEASE_LIST_PAGE_SIZE
  } catch {
    return false
  }
}

export async function fetchLatestRelease(opts: {
  baseUrl: string
  userAgent: string
  channel: UpdateChannel
  betaAsset?: AssetName
  timeoutMs?: number
}): Promise<LatestRelease> {
  const query = releaseQuery(opts.channel, opts.betaAsset ?? dmgAssetName)
  const paged = query.path !== 'releases/latest'
  let result: LatestRelease = { kind: 'none' }
  for (let page = 1; page <= (paged ? RELEASE_LIST_MAX_PAGES : 1); page++) {
    const path = page === 1 ? query.path : `${query.path}&page=${page}`
    const fetched = await fetchPage(opts, path)
    if (fetched.kind === 'done') return fetched.result
    result = readRelease(fetched.text, query.parse)
    if (result.kind === 'release' || !isFullPage(fetched.text)) return result
  }
  return result
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
    if (deps.now() >= nextAutoAt && deps.enabled()) await check('auto')
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

export function registerReleaseCheck(deps: {
  openExternal: (url: string) => boolean
  readSettings: () => unknown
  log: AppLog | null
  version: string
  method: () => InstallMethod
  updateRunner: UpdateRunner
  replaceAvailability: () => Promise<ReplaceAvailability | null>
  replacer: InstallReplacer
  broadcast: (channel: string, payload: unknown) => void
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
        betaAsset: isMacInstall(deps.method()) ? dmgAssetName : tarballAssetName,
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
      void stateOf(pending).then((state) => deps.broadcast('app:release-available', state))
    },
    log: (trigger, outcome, latest) =>
      deps.log?.info('release-check', { trigger, outcome, latest }),
  })
  if (endpoint.automatic) {
    setTimeout(() => void checker.tick(), RELEASE_CHECK_STARTUP_DELAY_MS).unref()
    setInterval(() => void checker.tick(), RELEASE_CHECK_TICK_MS).unref()
  }
  ipcMain.handle('app:release-state', () => stateOf(checker.pending()))
  ipcMain.handle('app:install-replace', () => {
    const release = checker.available()
    return release ? deps.replacer.start(release) : 'no-action'
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
