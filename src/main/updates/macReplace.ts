import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type EnvSource, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { parseBuildInfo, releaseVersion } from '../../shared/app/buildInfo'
import type { ReplaceAvailability, ReplaceProgress } from '../../shared/app/installMethod'
import { dmgAssetName, type ReleaseInfo } from '../../shared/app/releases'
import type { Fetch } from '../platform/checkedDownload'
import { bundleFs } from './bundleFs'
import {
  CHECKSUMS_FILE,
  CHECKSUMS_MAX_BYTES,
  checksumFor,
  downloadTo,
  fetchText,
  ReplaceError,
  releaseAssetUrl,
  replaceableAt,
  UPDATE_ARCHIVE_MAX_BYTES,
} from './installReplace'

const MAC_TEAM_ID = '4ZNCN9338G'
const MAC_BUNDLE_ID = 'ai.aurigax.ostia'
const DMG_APP = 'Ostia.app'
const UPDATE_SIGNATURE_ENV = 'UPDATE_SIGNATURE'
const COMMAND_TIMEOUT_MS = 5 * 60_000
const SWAP_VERIFY_TIMEOUT_MS = 60_000
const NOTARIZED = /^source=Notarized Developer ID$/m

export type SignaturePolicy = 'release' | 'adhoc'

export function signaturePolicy(isPackaged: boolean, env: EnvSource): SignaturePolicy {
  if (isPackaged) return 'release'
  return readEnv(UPDATE_SIGNATURE_ENV, env) === 'adhoc' ? 'adhoc' : 'release'
}

export function designatedRequirement(policy: SignaturePolicy): string {
  const identifier = `identifier "${MAC_BUNDLE_ID}"`
  if (policy === 'adhoc') return identifier
  return `anchor apple generic and certificate leaf[subject.OU] = "${MAC_TEAM_ID}" and ${identifier}`
}

export const stagedBundlePath = (bundle: string): string =>
  join(dirname(bundle), `.${basename(bundle)}.new`)
export const oldBundlePath = (bundle: string): string => `${bundle}.old`

export async function canReplaceBundle(
  bundle: string,
  arch: string = process.arch,
): Promise<ReplaceAvailability> {
  if (arch !== 'arm64') return { ok: false, reason: 'unsupported' }
  if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated' }
  if (bundle.startsWith('/Volumes/')) return { ok: false, reason: 'read-only' }
  return replaceableAt(bundle, [stagedBundlePath(bundle), oldBundlePath(bundle)])
}

export interface CommandResult {
  code: number
  output: string
}

export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>

export const runCommand: RunCommand = (command, args) =>
  new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { shell: false, timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolvePromise({ code, output: `${stdout}${stderr}` })
      },
    )
  })

async function bundleVersion(bundle: string, run: RunCommand): Promise<string | null> {
  const plist = await run('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    join(bundle, 'Contents', 'Info.plist'),
  ])
  return plist.code === 0 ? plist.output.trim() : null
}

async function buildInfoVersion(bundle: string): Promise<string | null> {
  try {
    const info = parseBuildInfo(
      JSON.parse(await readFile(join(bundle, 'Contents', 'Resources', 'build-info.json'), 'utf8')),
    )
    return info ? releaseVersion(info.version) : null
  } catch {
    return null
  }
}

async function verifyBundle(opts: {
  bundle: string
  version: string
  policy: SignaturePolicy
  run: RunCommand
}): Promise<void> {
  const { bundle, run } = opts
  const strict = ['--verify', '--deep', '--strict']
  if ((await run('codesign', [...strict, bundle])).code !== 0) {
    throw new ReplaceError('bad-signature')
  }
  const requirement = `-R=${designatedRequirement(opts.policy)}`
  if ((await run('codesign', [...strict, requirement, bundle])).code !== 0) {
    throw new ReplaceError('wrong-team')
  }
  if (opts.policy === 'release') {
    const assessed = await run('spctl', ['-a', '-t', 'exec', '-vv', bundle])
    if (assessed.code !== 0 || !NOTARIZED.test(assessed.output)) {
      throw new ReplaceError('not-notarized')
    }
  }
  const [plist, built] = await Promise.all([bundleVersion(bundle, run), buildInfoVersion(bundle)])
  if (plist !== opts.version || built !== opts.version) throw new ReplaceError('wrong-version')
}

async function detach(mountPoint: string, run: RunCommand): Promise<void> {
  if ((await run('hdiutil', ['detach', mountPoint])).code === 0) return
  await run('hdiutil', ['detach', '-force', mountPoint])
}

export async function replaceMacInstall(opts: {
  bundle: string
  release: ReleaseInfo
  base: string
  fetch: Fetch
  run: RunCommand
  policy: SignaturePolicy
  signal: AbortSignal
  onProgress: (progress: ReplaceProgress) => void
  onInstalling: () => void
  workRoot?: string
  arch?: string
}): Promise<void> {
  const { bundle, run } = opts
  const { version } = opts.release
  const asset = dmgAssetName(version)
  const dmgUrl = releaseAssetUrl(opts.base, version, asset)
  const sumsUrl = releaseAssetUrl(opts.base, version, CHECKSUMS_FILE)
  if (!dmgUrl || !sumsUrl) throw new ReplaceError('http-error')
  if (!(await canReplaceBundle(bundle, opts.arch)).ok) throw new ReplaceError('blocked')
  const staged = stagedBundlePath(bundle)
  const work = await mkdtemp(join(opts.workRoot ?? tmpdir(), `${PRODUCT_NAME}-update-`))
  const mountPoint = join(work, 'mount')
  let mounted = false
  try {
    const published = opts.release.dmgSha256
    if (!published) throw new ReplaceError('no-checksum')
    const sums = await fetchText(opts.fetch, sumsUrl, opts.base, CHECKSUMS_MAX_BYTES, opts.signal)
    const expected = checksumFor(sums, asset)
    if (!expected) throw new ReplaceError('no-checksum')
    if (expected !== published) throw new ReplaceError('checksum-mismatch')
    const actual = await downloadTo({
      fetch: opts.fetch,
      url: dmgUrl,
      base: opts.base,
      file: join(work, asset),
      maxBytes: UPDATE_ARCHIVE_MAX_BYTES,
      signal: opts.signal,
      onProgress: opts.onProgress,
    })
    if (actual !== expected) throw new ReplaceError('checksum-mismatch')
    opts.onInstalling()
    await mkdir(mountPoint)
    const attached = await run('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      '-mountpoint',
      mountPoint,
      join(work, asset),
    ])
    if (attached.code !== 0) throw new ReplaceError('mount-failed')
    mounted = true
    if ((await run('ditto', [join(mountPoint, DMG_APP), staged])).code !== 0) {
      throw new ReplaceError('extract-failed')
    }
    await detach(mountPoint, run)
    mounted = false
    await verifyBundle({ bundle: staged, version, policy: opts.policy, run })
  } catch (err) {
    await bundleFs.promises.rm(staged, { recursive: true, force: true })
    throw err instanceof ReplaceError ? err : new ReplaceError('extract-failed')
  } finally {
    if (mounted) await detach(mountPoint, run)
    await bundleFs.promises.rm(work, { recursive: true, force: true })
  }
}

export function macReplace(deps: {
  base: string
  fetch: Fetch
  run: RunCommand
  policy: SignaturePolicy
}): (job: {
  appDir: string
  release: ReleaseInfo
  signal: AbortSignal
  onProgress: (progress: ReplaceProgress) => void
  onInstalling: () => void
}) => Promise<void> {
  return (job) => replaceMacInstall({ ...deps, ...job, bundle: job.appDir })
}

export async function discardStaged(bundle: string): Promise<void> {
  await bundleFs.promises.rm(stagedBundlePath(bundle), { recursive: true, force: true })
}

type Rename = (from: string, to: string) => void

export type SwapResult = 'swapped' | 'nothing-staged' | 'rejected' | 'failed'

export function verifyStagedSync(staged: string, policy: SignaturePolicy): boolean {
  try {
    execFileSync(
      'codesign',
      ['--verify', '--strict', `-R=${designatedRequirement(policy)}`, staged],
      { stdio: 'ignore', timeout: SWAP_VERIFY_TIMEOUT_MS },
    )
    return true
  } catch {
    return false
  }
}

export function swapStagedBundle(
  bundle: string,
  deps: { verify: (staged: string) => boolean; rename?: Rename },
): SwapResult {
  const rename = deps.rename ?? bundleFs.renameSync
  const staged = stagedBundlePath(bundle)
  const old = oldBundlePath(bundle)
  const kind = (path: string): 'dir' | 'other' | null => {
    try {
      return bundleFs.lstatSync(path).isDirectory() ? 'dir' : 'other'
    } catch {
      return null
    }
  }
  const stagedKind = kind(staged)
  if (stagedKind === null) return 'nothing-staged'
  if (stagedKind !== 'dir' || !deps.verify(staged)) {
    bundleFs.rmSync(staged, { recursive: true, force: true })
    return 'rejected'
  }
  if (kind(old) !== null) return 'failed'
  try {
    rename(bundle, old)
  } catch {
    return 'failed'
  }
  try {
    rename(staged, bundle)
    return 'swapped'
  } catch {
    try {
      rename(old, bundle)
    } catch {}
    return 'failed'
  }
}
