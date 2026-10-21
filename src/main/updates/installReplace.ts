import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { type EnvSource, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { list as listTar, type ReadEntry } from 'tar'
import { parseBuildInfo, releaseVersion } from '../../shared/app/buildInfo'
import {
  type ReplaceAvailability,
  type ReplaceFailure,
  type ReplaceProgress,
  type ReplaceStart,
  type ReplaceState,
  UPDATE_DOWNLOAD_HOSTS,
} from '../../shared/app/installMethod'
import {
  parseVersion,
  RELEASE_REPOSITORY,
  type ReleaseInfo,
  tarballAssetName,
} from '../../shared/app/releases'
import {
  DownloadError,
  type DownloadRequest,
  downloadChecked,
  type Fetch,
  followAllowed,
  isAllowedHop,
  readCapped,
} from '../platform/checkedDownload'
import { isInsidePath } from '../platform/pathGuard'
import { bundleFs } from './bundleFs'

export const UPDATE_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024
export const CHECKSUMS_MAX_BYTES = 64 * 1024
const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const EXTRACT_TIMEOUT_MS = 10 * 60_000
const RELEASE_DOWNLOAD_BASE_URL = 'https://github.com'
const RELEASE_DOWNLOAD_BASE_URL_ENV = 'RELEASE_DOWNLOAD_BASE_URL'
export const CHECKSUMS_FILE = 'SHA256SUMS'
const PROGRESS_STEP_BYTES = 1024 * 1024
const SYSTEM_PARENTS = ['/opt', '/usr'] as const

const SAFE_TAR_TYPES: ReadonlySet<string> = new Set([
  'File',
  'OldFile',
  'ContiguousFile',
  'Directory',
  'SymbolicLink',
  'Link',
])

export class ReplaceError extends Error {
  constructor(readonly reason: ReplaceFailure) {
    super(reason)
  }
}

const downloadPath = (appDir: string): string => `${appDir}.download`
const newPath = (appDir: string): string => `${appDir}.new`
const oldPath = (appDir: string): string => `${appDir}.old`

export function releaseDownloadBase(isPackaged: boolean, env: EnvSource): string {
  return (
    (isPackaged ? undefined : readEnv(RELEASE_DOWNLOAD_BASE_URL_ENV, env)) ??
    RELEASE_DOWNLOAD_BASE_URL
  )
}

export function releaseAssetUrl(base: string, version: string, asset: string): URL | null {
  if (!parseVersion(version) || version.includes('+') || !/^[A-Za-z0-9._-]+$/.test(asset)) {
    return null
  }
  const { owner, name } = RELEASE_REPOSITORY
  return new URL(
    `${base.replace(/\/+$/, '')}/${owner}/${name}/releases/download/v${version}/${asset}`,
  )
}

export function allowedHop(url: URL, base: string): boolean {
  return isAllowedHop(url, UPDATE_DOWNLOAD_HOSTS, base === RELEASE_DOWNLOAD_BASE_URL ? null : base)
}

export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd())
    if (match && match[2] === asset) return match[1]
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function writable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function replaceableAt(
  target: string,
  leftovers: readonly string[],
): Promise<ReplaceAvailability> {
  try {
    if ((await lstat(target)).isSymbolicLink()) return { ok: false, reason: 'symlink' }
  } catch {
    return { ok: false, reason: 'not-writable' }
  }
  for (const leftover of leftovers) {
    if (await exists(leftover)) return { ok: false, reason: 'leftover', path: leftover }
  }
  if (!(await writable(target)) || !(await writable(dirname(target)))) {
    return { ok: false, reason: 'not-writable' }
  }
  return { ok: true }
}

export async function canReplaceInstall(appDir: string): Promise<ReplaceAvailability> {
  if (SYSTEM_PARENTS.some((dir) => isInsidePath(dir, dirname(appDir))))
    return { ok: false, reason: 'system-path' }
  return replaceableAt(appDir, [newPath(appDir), oldPath(appDir)])
}

function strippedEntry(path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  return parts.length > 1 ? parts.slice(1).join('/') : null
}

function leavesRoot(segments: string[]): boolean {
  let depth = 0
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    depth += segment === '..' ? -1 : 1
    if (depth < 0) return true
  }
  return depth === 0
}

export function entryProblem(entry: { path: string; type: string; linkpath?: string }): boolean {
  const { path, type, linkpath } = entry
  if (!SAFE_TAR_TYPES.has(type)) return true
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return true
  if (path.split('/').includes('..')) return true
  const inside = strippedEntry(path)
  if (type === 'SymbolicLink') {
    if (!linkpath || linkpath.startsWith('/') || linkpath.includes('\0') || !inside) return true
    return leavesRoot([...inside.split('/').slice(0, -1), ...linkpath.split('/')])
  }
  if (type === 'Link') {
    if (!linkpath || linkpath.startsWith('/') || linkpath.split('/').includes('..')) return true
    return strippedEntry(linkpath) === null
  }
  return false
}

export async function checkArchive(file: string): Promise<void> {
  let bad = false
  const onReadEntry = (entry: ReadEntry): void => {
    if (entryProblem({ path: entry.path, type: entry.type, linkpath: entry.linkpath })) bad = true
    entry.resume()
  }
  try {
    await listTar({ file, strict: true, onReadEntry })
  } catch {
    throw new ReplaceError('bad-archive')
  }
  if (bad) throw new ReplaceError('bad-archive')
}

async function checkExtracted(dir: string, version: string): Promise<void> {
  try {
    const binary = await stat(resolve(dir, PRODUCT_NAME))
    if (!binary.isFile() || (binary.mode & 0o111) === 0) throw new ReplaceError('not-executable')
  } catch (err) {
    throw err instanceof ReplaceError ? err : new ReplaceError('not-executable')
  }
  let info: ReturnType<typeof parseBuildInfo> = null
  try {
    info = parseBuildInfo(
      JSON.parse(await readFile(resolve(dir, 'resources', 'build-info.json'), 'utf8')),
    )
  } catch {}
  if (!info || releaseVersion(info.version) !== version) throw new ReplaceError('wrong-version')
}

function replaceFailure(err: unknown): ReplaceError {
  if (err instanceof ReplaceError) return err
  if (!(err instanceof DownloadError)) return new ReplaceError('offline')
  return new ReplaceError(err.reason === 'host-not-allowed' ? 'redirect-refused' : err.reason)
}

function releaseRequest(
  fetchImpl: Fetch,
  url: URL,
  base: string,
  signal: AbortSignal,
): DownloadRequest {
  return {
    fetch: fetchImpl,
    url,
    allowed: (hop) => allowedHop(hop, base),
    userAgent: PRODUCT_NAME,
    signal,
  }
}

export async function fetchText(
  fetchImpl: Fetch,
  url: URL,
  base: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  let text: string | null
  try {
    const response = await followAllowed(releaseRequest(fetchImpl, url, base, signal))
    if (!response.body) throw new ReplaceError('offline')
    text = await readCapped(response.body, maxBytes)
  } catch (err) {
    throw replaceFailure(err)
  }
  if (text === null) throw new ReplaceError('too-large')
  return text
}

export async function downloadTo(opts: {
  fetch: Fetch
  url: URL
  base: string
  file: string
  maxBytes: number
  signal: AbortSignal
  onProgress: (progress: ReplaceProgress) => void
}): Promise<string> {
  let reported = 0
  try {
    return await downloadChecked({
      ...releaseRequest(opts.fetch, opts.url, opts.base, opts.signal),
      file: opts.file,
      exclusive: true,
      maxBytes: opts.maxBytes,
      onProgress: (received, total) => {
        if (received - reported < PROGRESS_STEP_BYTES && received !== total) return
        reported = received
        opts.onProgress({ received, total })
      },
    })
  } catch (err) {
    throw replaceFailure(err)
  }
}

export type RunTar = (args: string[]) => Promise<void>

export const runTar: RunTar = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile('tar', args, { shell: false, timeout: EXTRACT_TIMEOUT_MS }, (err) =>
      err ? reject(new ReplaceError('extract-failed')) : resolvePromise(),
    )
  })

export async function swapInstall(appDir: string): Promise<void> {
  try {
    await bundleFs.promises.rename(appDir, oldPath(appDir))
  } catch {
    throw new ReplaceError('swap-failed')
  }
  try {
    await bundleFs.promises.rename(newPath(appDir), appDir)
  } catch {
    await bundleFs.promises.rename(oldPath(appDir), appDir).catch(() => {})
    throw new ReplaceError('swap-failed')
  }
}

export async function replaceInstall(opts: {
  appDir: string
  version: string
  base: string
  fetch: Fetch
  tar: RunTar
  signal: AbortSignal
  onProgress: (progress: ReplaceProgress) => void
  onInstalling: () => void
}): Promise<void> {
  const { appDir, version } = opts
  const asset = tarballAssetName(version)
  const archiveUrl = releaseAssetUrl(opts.base, version, asset)
  const sumsUrl = releaseAssetUrl(opts.base, version, CHECKSUMS_FILE)
  if (!archiveUrl || !sumsUrl) throw new ReplaceError('http-error')
  if (!(await canReplaceInstall(appDir)).ok) throw new ReplaceError('blocked')
  const file = downloadPath(appDir)
  const staged = newPath(appDir)
  await bundleFs.promises.rm(file, { force: true })
  try {
    const sums = await fetchText(opts.fetch, sumsUrl, opts.base, CHECKSUMS_MAX_BYTES, opts.signal)
    const expected = checksumFor(sums, asset)
    if (!expected) throw new ReplaceError('no-checksum')
    const actual = await downloadTo({
      fetch: opts.fetch,
      url: archiveUrl,
      base: opts.base,
      file,
      maxBytes: UPDATE_ARCHIVE_MAX_BYTES,
      signal: opts.signal,
      onProgress: opts.onProgress,
    })
    if (actual !== expected) throw new ReplaceError('checksum-mismatch')
    opts.onInstalling()
    await checkArchive(file)
    await mkdir(staged, { mode: 0o755 })
    await opts.tar(['-xzf', file, '--strip-components=1', '-C', staged])
    await checkExtracted(staged, version)
    await swapInstall(appDir)
  } catch (err) {
    await bundleFs.promises.rm(staged, { recursive: true, force: true })
    throw err instanceof ReplaceError ? err : new ReplaceError('extract-failed')
  } finally {
    await bundleFs.promises.rm(file, { force: true })
  }
}

export interface PendingSweep {
  appDir: string
  version: string
}

export async function sweepOldInstall(
  pending: PendingSweep | null,
  appDir: string | null,
  runningVersion: string,
): Promise<boolean> {
  if (!pending || !appDir || pending.appDir !== appDir) return false
  if (releaseVersion(runningVersion) !== pending.version) return false
  await bundleFs.promises.rm(oldPath(appDir), { recursive: true, force: true })
  return true
}

export interface ReplaceJob {
  appDir: string
  release: ReleaseInfo
  signal: AbortSignal
  onProgress: (progress: ReplaceProgress) => void
  onInstalling: () => void
}

export interface InstallReplacer {
  start: (release: ReleaseInfo) => Promise<ReplaceStart>
  state: () => ReplaceState
}

export function tarballReplace(deps: {
  base: string
  fetch: Fetch
  tar: RunTar
}): (job: ReplaceJob) => Promise<void> {
  return (job) =>
    replaceInstall({
      appDir: job.appDir,
      version: job.release.version,
      base: deps.base,
      fetch: deps.fetch,
      tar: deps.tar,
      signal: job.signal,
      onProgress: job.onProgress,
      onInstalling: job.onInstalling,
    })
}

export function createInstallReplacer(deps: {
  appDir: () => string | null
  replace: (job: ReplaceJob) => Promise<void>
  onState: (state: ReplaceState) => void
  onProgress: (progress: ReplaceProgress) => void
  onReplaced: (pending: PendingSweep) => void
}): InstallReplacer {
  let state: ReplaceState = { status: 'idle' }
  const set = (next: ReplaceState): void => {
    state = next
    deps.onState(next)
  }
  return {
    state: () => state,
    start: async (release) => {
      const appDir = deps.appDir()
      if (!appDir) return 'no-action'
      if (state.status === 'downloading' || state.status === 'installing') return 'busy'
      const { version } = release
      set({ status: 'downloading' })
      void deps
        .replace({
          appDir,
          release,
          signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
          onProgress: deps.onProgress,
          onInstalling: () => set({ status: 'installing' }),
        })
        .then(
          () => {
            deps.onReplaced({ appDir, version })
            set({ status: 'done', version })
          },
          (err: unknown) =>
            set({
              status: 'failed',
              reason: err instanceof ReplaceError ? err.reason : 'extract-failed',
            }),
        )
      return 'started'
    },
  }
}
