import { type ExecFileException, execFile as execFileProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { type ReadEntry, extract as extractTar, list as listTar } from 'tar'
import { type Entry, type ZipFile, open as openZip } from 'yauzl'
import {
  LANGUAGE_SERVER_DOWNLOAD_HOSTS,
  type LanguageServerAsset,
  type LanguageServerFetchFailure,
  type LanguageServerGoInstall,
  type LanguageServerPlatform,
  type LanguageServerRun,
  goInstallArgs,
  isDownloadRun,
  isGoInstallRun,
  pinnedVersion,
} from '../shared/languageServers'
import { redactSecrets } from './appLog'

export const DOWNLOAD_BASE_URL_ENV = 'PINE_LSP_DOWNLOAD_BASE_URL'
export const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024
export const EXTRACT_MAX_BYTES = 1024 * 1024 * 1024
export const EXTRACT_MAX_FILES = 20_000
export const DOWNLOAD_MAX_REDIRECTS = 5
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
export const GO_INSTALL_TIMEOUT_MS = 15 * 60_000
const GO_OUTPUT_MAX_BYTES = 1024 * 1024
const OUTPUT_LINE_MAX = 500
const SYMLINK_TYPE = 0o120000
const FILE_TYPE_MASK = 0o170000
const TAR_FILE_TYPES: ReadonlySet<string> = new Set(['File', 'OldFile', 'ContiguousFile'])

export function downloadBaseUrl(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): string | null {
  return isPackaged ? null : env[DOWNLOAD_BASE_URL_ENV] || null
}

export class FetchError extends Error {
  constructor(
    readonly reason: LanguageServerFetchFailure,
    readonly detail = '',
  ) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}

export interface FetchHooks {
  onProgress?: (percent: number) => void
  onOutput?: (line: string) => void
}

export type ExecFile = (
  file: string,
  args: string[],
  options: {
    shell: false
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    maxBuffer: number
    windowsHide: true
  },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown

export interface ManagedServersDeps {
  dir: string
  userAgent: string
  findProgram: (program: string) => string | null
  env: () => NodeJS.ProcessEnv
  platform?: string
  baseUrl?: string | null
  fetch?: typeof fetch
  execFile?: ExecFile
  maxDownloadBytes?: number
  maxExtractBytes?: number
  maxExtractFiles?: number
  downloadTimeoutMs?: number
  goTimeoutMs?: number
}

function isInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

function entryTarget(stage: string, name: string): string {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/')) {
    throw new FetchError('bad-archive', 'an entry has an unsafe name')
  }
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new FetchError('bad-archive', 'an entry leaves the folder')
  const target = resolve(stage, ...segments)
  if (!isInside(target, stage)) throw new FetchError('bad-archive', 'an entry leaves the folder')
  return target
}

class Budget {
  private bytes = 0
  private files = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {}

  file(size: number): void {
    this.files += 1
    this.add(size)
    if (this.files > this.maxFiles) throw new FetchError('too-large', 'too many files')
  }

  add(size: number): void {
    this.bytes += size
    if (this.bytes > this.maxBytes) throw new FetchError('too-large', 'unpacks to too many bytes')
  }
}

function capped(budget: Budget): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        budget.add(chunk.byteLength)
        done(null, chunk)
      } catch (err) {
        done(err as Error)
      }
    },
  })
}

async function unpackGzip(file: string, target: string, budget: Budget): Promise<void> {
  budget.file(0)
  await pipeline(createReadStream(file), createGunzip(), capped(budget), createWriteStream(target))
}

async function unpackTar(file: string, stage: string, budget: Budget): Promise<void> {
  let problem: FetchError | null = null
  const check = (entry: ReadEntry): void => {
    if (problem) return
    try {
      entryTarget(stage, entry.path)
      if (entry.type === 'Directory') return
      if (!TAR_FILE_TYPES.has(entry.type)) {
        throw new FetchError('bad-archive', 'it holds a link or special file')
      }
      budget.file(entry.size)
    } catch (err) {
      problem = err instanceof FetchError ? err : new FetchError('bad-archive')
    }
  }
  await listTar({ file, strict: true, onReadEntry: check })
  if (problem) throw problem
  await extractTar({ file, cwd: stage, strict: true, preservePaths: false })
}

function openArchive(file: string): Promise<ZipFile> {
  return new Promise((done, fail) => {
    openZip(
      file,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false },
      (err, zip) => (err ? fail(err) : done(zip)),
    )
  })
}

function zipEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((done, fail) => {
    const entries: Entry[] = []
    zip.on('entry', (entry: Entry) => {
      entries.push(entry)
      zip.readEntry()
    })
    zip.once('end', () => done(entries))
    zip.once('error', fail)
    zip.readEntry()
  })
}

function zipStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((done, fail) => {
    zip.openReadStream(entry, (err, stream) => (err ? fail(err) : done(stream)))
  })
}

async function unpackZip(file: string, stage: string, budget: Budget): Promise<void> {
  const zip = await openArchive(file)
  try {
    const entries = await zipEntries(zip)
    const files: { entry: Entry; target: string; mode: number }[] = []
    for (const entry of entries) {
      const target = entryTarget(stage, entry.fileName)
      if (entry.fileName.endsWith('/')) continue
      const unixMode = entry.externalFileAttributes >>> 16
      if ((unixMode & FILE_TYPE_MASK) === SYMLINK_TYPE) {
        throw new FetchError('bad-archive', 'it holds a link or special file')
      }
      budget.file(entry.uncompressedSize)
      files.push({ entry, target, mode: unixMode & 0o111 ? 0o755 : 0o644 })
    }
    for (const { entry, target, mode } of files) {
      mkdirSync(dirname(target), { recursive: true })
      await pipeline(await zipStream(zip, entry), createWriteStream(target, { mode }))
    }
  } finally {
    zip.close()
  }
}

function clip(text: string): string {
  return redactSecrets(text).slice(0, OUTPUT_LINE_MAX)
}

export class ManagedServers {
  private readonly running = new Map<string, Promise<string>>()

  constructor(private readonly deps: ManagedServersDeps) {}

  private platform(): string {
    return this.deps.platform ?? `${process.platform}-${process.arch}`
  }

  private serverDir(extId: string, serverId: string): string {
    return join(this.deps.dir, extId, serverId)
  }

  folder(extId: string, serverId: string, version: string): string {
    return join(this.serverDir(extId, serverId), version)
  }

  assetFor(run: LanguageServerRun): LanguageServerAsset | null {
    if (!isDownloadRun(run)) return null
    return run.download.assets[this.platform() as LanguageServerPlatform] ?? null
  }

  canFetch(run: LanguageServerRun): boolean {
    return isGoInstallRun(run) || this.assetFor(run) !== null
  }

  private relativeExecutable(run: LanguageServerRun): string | null {
    if (isGoInstallRun(run)) {
      return this.platform().startsWith('win32')
        ? `${run.goInstall.binary}.exe`
        : run.goInstall.binary
    }
    return this.assetFor(run)?.executable ?? null
  }

  executable(extId: string, serverId: string, run: LanguageServerRun): string | null {
    const version = pinnedVersion(run)
    const relative = this.relativeExecutable(run)
    if (version === null || relative === null) return null
    const path = join(this.folder(extId, serverId, version), relative)
    try {
      return lstatSync(path).isFile() ? path : null
    } catch {
      return null
    }
  }

  fetch(
    extId: string,
    serverId: string,
    run: LanguageServerRun,
    hooks: FetchHooks = {},
  ): Promise<string> {
    const key = `${extId}/${serverId}@${pinnedVersion(run) ?? ''}`
    const pending = this.running.get(key)
    if (pending) return pending
    const started = this.install(extId, serverId, run, hooks).finally(() => {
      if (this.running.get(key) === started) this.running.delete(key)
    })
    this.running.set(key, started)
    return started
  }

  private async install(
    extId: string,
    serverId: string,
    run: LanguageServerRun,
    hooks: FetchHooks,
  ): Promise<string> {
    const version = pinnedVersion(run)
    const relative = this.relativeExecutable(run)
    if (version === null || relative === null) throw new FetchError('executable-missing')
    const serverDir = this.serverDir(extId, serverId)
    const stage = join(serverDir, `.stage-${randomUUID()}`)
    const download = join(serverDir, `.download-${randomUUID()}`)
    try {
      mkdirSync(stage, { recursive: true, mode: 0o700 })
      if (isGoInstallRun(run)) {
        await this.goInstall(run.goInstall, stage, hooks)
      } else {
        const asset = this.assetFor(run)
        if (!asset) throw new FetchError('executable-missing')
        await this.download(asset, download, hooks)
        await this.unpack(asset, download, stage)
      }
      const executable = join(stage, relative)
      if (
        !isInside(executable, stage) ||
        !existsSync(executable) ||
        !lstatSync(executable).isFile()
      ) {
        throw new FetchError('executable-missing')
      }
      chmodSync(executable, 0o755)
      const target = this.folder(extId, serverId, version)
      rmSync(target, { recursive: true, force: true })
      renameSync(stage, target)
      chmodSync(target, 0o700)
      this.dropOtherVersions(serverDir, version)
      return join(target, relative)
    } catch (err) {
      throw err instanceof FetchError
        ? err
        : new FetchError('write-failed', clip((err as Error).message))
    } finally {
      rmSync(stage, { recursive: true, force: true })
      rmSync(download, { force: true })
    }
  }

  private requestUrl(raw: string): URL {
    const url = new URL(raw)
    if (!this.deps.baseUrl) return url
    return new URL(`${url.pathname}${url.search}`, this.deps.baseUrl)
  }

  private allowed(url: URL): boolean {
    if (this.deps.baseUrl) return url.origin === new URL(this.deps.baseUrl).origin
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      LANGUAGE_SERVER_DOWNLOAD_HOSTS.includes(url.hostname)
    )
  }

  private async download(
    asset: LanguageServerAsset,
    file: string,
    hooks: FetchHooks,
  ): Promise<void> {
    const limit = this.deps.maxDownloadBytes ?? DOWNLOAD_MAX_BYTES
    const signal = AbortSignal.timeout(this.deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS)
    let url = this.requestUrl(asset.url)
    if (!this.allowed(url)) throw new FetchError('host-not-allowed', url.hostname)
    let response: Response
    try {
      for (let hop = 0; ; hop++) {
        response = await (this.deps.fetch ?? fetch)(url, {
          headers: { 'User-Agent': this.deps.userAgent },
          redirect: 'manual',
          signal,
        })
        if (response.status < 300 || response.status > 399) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || hop >= DOWNLOAD_MAX_REDIRECTS) throw new FetchError('redirect-refused')
        const next = new URL(location, url)
        if (!this.allowed(next)) throw new FetchError('redirect-refused', next.hostname)
        url = next
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw new FetchError('http-error', String(response.status))
      }
      const expected = Number(response.headers.get('content-length') ?? 0)
      if (expected > limit) {
        await response.body.cancel()
        throw new FetchError('too-large', 'the download is too large')
      }
      const hash = createHash('sha256')
      let received = 0
      let reported = -1
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.byteLength
          if (received > limit) {
            done(new FetchError('too-large', 'the download is too large'))
            return
          }
          hash.update(chunk)
          const percent = expected > 0 ? Math.floor((received / expected) * 100) : 0
          if (percent !== reported) {
            reported = percent
            hooks.onProgress?.(Math.min(percent, 100))
          }
          done(null, chunk)
        },
      })
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(file, { mode: 0o600 }),
      )
      if (hash.digest('hex') !== asset.sha256) throw new FetchError('checksum-mismatch')
    } catch (err) {
      if (err instanceof FetchError) throw err
      const name = (err as Error).name
      throw new FetchError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'offline',
        clip((err as Error).message),
      )
    }
  }

  private async unpack(asset: LanguageServerAsset, file: string, stage: string): Promise<void> {
    const budget = new Budget(
      this.deps.maxExtractBytes ?? EXTRACT_MAX_BYTES,
      this.deps.maxExtractFiles ?? EXTRACT_MAX_FILES,
    )
    try {
      if (asset.archive === 'plain') renameSync(file, join(stage, asset.executable))
      else if (asset.archive === 'gz') await unpackGzip(file, join(stage, asset.executable), budget)
      else if (asset.archive === 'tar.gz') await unpackTar(file, stage, budget)
      else await unpackZip(file, stage, budget)
    } catch (err) {
      if (err instanceof FetchError) throw err
      throw new FetchError('bad-archive', clip((err as Error).message))
    }
  }

  private goInstall(
    install: LanguageServerGoInstall,
    stage: string,
    hooks: FetchHooks,
  ): Promise<void> {
    const go = this.deps.findProgram('go')
    if (go === null) return Promise.reject(new FetchError('command-failed', 'go is not on PATH'))
    const report = (text: string): void => {
      for (const line of text.split('\n')) if (line.trim()) hooks.onOutput?.(clip(line.trimEnd()))
    }
    return new Promise((done, fail) => {
      ;(this.deps.execFile ?? (execFileProcess as unknown as ExecFile))(
        go,
        goInstallArgs(install),
        {
          shell: false,
          cwd: stage,
          env: { ...this.deps.env(), GOBIN: stage, GOFLAGS: '' },
          timeout: this.deps.goTimeoutMs ?? GO_INSTALL_TIMEOUT_MS,
          maxBuffer: GO_OUTPUT_MAX_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          report(String(stdout))
          report(String(stderr))
          if (!error) {
            done()
          } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            fail(new FetchError('command-failed', 'go install printed too much'))
          } else if (error.killed) {
            fail(new FetchError('timeout', 'go install took too long'))
          } else {
            fail(
              new FetchError(
                'command-failed',
                `go install exited with ${error.code ?? 'an error'}`,
              ),
            )
          }
        },
      )
    })
  }

  private dropOtherVersions(serverDir: string, keep: string): void {
    for (const name of readdirSync(serverDir)) {
      if (name === keep || name.startsWith('.stage-') || name.startsWith('.download-')) continue
      rmSync(join(serverDir, name), { recursive: true, force: true })
    }
  }

  remove(extId: string, serverId: string): void {
    rmSync(this.serverDir(extId, serverId), { recursive: true, force: true })
  }

  forgetExtension(extId: string): void {
    rmSync(join(this.deps.dir, extId), { recursive: true, force: true })
  }

  private fetching(key: string): boolean {
    const prefix = `${key}@`
    return [...this.running.keys()].some((running) => running.startsWith(prefix))
  }

  retain(keep: ReadonlyMap<string, string>): void {
    for (const extId of this.children(this.deps.dir)) {
      const extDir = join(this.deps.dir, extId)
      for (const serverId of this.children(extDir)) {
        const key = `${extId}/${serverId}`
        const version = keep.get(key)
        const serverDir = join(extDir, serverId)
        if (version === undefined) {
          if (!this.fetching(key)) rmSync(serverDir, { recursive: true, force: true })
          continue
        }
        for (const name of this.children(serverDir)) {
          if (name === version || this.fetching(key)) continue
          rmSync(join(serverDir, name), { recursive: true, force: true })
        }
      }
      if (this.children(extDir).length === 0) rmSync(extDir, { recursive: true, force: true })
    }
  }

  private children(dir: string): string[] {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
}
