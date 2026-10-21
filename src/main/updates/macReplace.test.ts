import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReleaseInfo } from '../../shared/app/releases'
import { ReplaceError } from './installReplace'
import {
  type CommandResult,
  canReplaceBundle,
  designatedRequirement,
  discardStaged,
  oldBundlePath,
  type RunCommand,
  replaceMacInstall,
  runCommand,
  signaturePolicy,
  stagedBundlePath,
  swapStagedBundle,
  verifyStagedSync,
} from './macReplace'

const VERSION = '0.6.0-rc.2'
const DMG = `ostia-${VERSION}-arm64.dmg`
const DOWNLOAD = `/aurigax-ai/ostia/releases/download/v${VERSION}`
const TEAM_REQUIREMENT =
  'anchor apple generic and certificate leaf[subject.OU] = "4ZNCN9338G" and identifier "ai.aurigax.ostia"'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia mac replace '))
})

afterEach(() => {
  chmodSync(root, 0o755)
  rmSync(root, { recursive: true, force: true })
})

function appBundle(dir: string, version: string): string {
  mkdirSync(join(dir, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(dir, 'Contents', 'Resources', 'app.asar'), 'asar archive')
  writeFileSync(join(dir, 'Contents', 'Info.plist'), version)
  writeFileSync(
    join(dir, 'Contents', 'Resources', 'build-info.json'),
    JSON.stringify({ version: `${version}+sha.abc`, builtAt: '2026-10-13T00:00:00Z' }),
  )
  return dir
}

function installed(): string {
  mkdirSync(join(root, 'Applications'))
  return appBundle(join(root, 'Applications', 'Ostia.app'), '0.5.12')
}

const bundleVersion = (bundle: string): string =>
  readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')

interface FakeTools {
  run: RunCommand
  calls: string[][]
  mounted: () => boolean
}

function fakeTools(
  image: string,
  over: Partial<
    Record<'codesign' | 'requirement' | 'spctl' | 'attach' | 'ditto', CommandResult>
  > & {
    plist?: string
  } = {},
): FakeTools {
  const calls: string[][] = []
  let mountPoint: string | null = null
  const ok: CommandResult = { code: 0, output: '' }
  const run: RunCommand = async (command, args) => {
    calls.push([command, ...args])
    if (command === 'hdiutil' && args[0] === 'attach') {
      if (over.attach) return over.attach
      mountPoint = args[args.indexOf('-mountpoint') + 1]
      cpSync(image, join(mountPoint, 'Ostia.app'), { recursive: true })
      return ok
    }
    if (command === 'hdiutil' && args[0] === 'detach') {
      if (mountPoint) rmSync(join(mountPoint, 'Ostia.app'), { recursive: true, force: true })
      mountPoint = null
      return ok
    }
    if (command === 'ditto') {
      if (over.ditto) return over.ditto
      cpSync(args[0], args[1], { recursive: true })
      return ok
    }
    if (command === 'codesign') {
      const requirement = args.some((a) => a.startsWith('-R='))
      return (requirement ? over.requirement : over.codesign) ?? ok
    }
    if (command === 'spctl') {
      return (
        over.spctl ?? {
          code: 0,
          output: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: AurigaX (4ZNCN9338G)\n`,
        }
      )
    }
    if (command === 'plutil') {
      const plist = args.at(-1) ?? ''
      return { code: 0, output: `${over.plist ?? readFileSync(plist, 'utf8')}\n` }
    }
    return { code: 127, output: `unexpected ${command}` }
  }
  return { run, calls, mounted: () => mountPoint !== null }
}

interface Release {
  url: string
  close: () => Promise<void>
}

async function serve(files: Record<string, Buffer>): Promise<Release> {
  const server: Server = createServer((req, res) => {
    const file = files[req.url ?? '']
    if (!file) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': file.byteLength })
    res.end(file)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const DMG_BYTES = Buffer.from('fake disk image bytes')
const DMG_SHA = createHash('sha256').update(DMG_BYTES).digest('hex')

function releaseFiles(sum = DMG_SHA): Record<string, Buffer> {
  return {
    [`${DOWNLOAD}/${DMG}`]: DMG_BYTES,
    [`${DOWNLOAD}/SHA256SUMS`]: Buffer.from(`${sum}  ${DMG}\n${'0'.repeat(64)}  other.tar.gz\n`),
  }
}

const releaseInfo = (dmgSha256: string | undefined = DMG_SHA): ReleaseInfo => ({
  version: VERSION,
  url: `https://github.com/aurigax-ai/ostia/releases/tag/v${VERSION}`,
  ...(dmgSha256 ? { dmgSha256 } : {}),
})

async function replaceWith(
  bundle: string,
  tools: FakeTools,
  opts: { files?: Record<string, Buffer>; release?: ReleaseInfo } = {},
): Promise<string> {
  const server = await serve(opts.files ?? releaseFiles())
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const stages: string[] = []
  try {
    await replaceMacInstall({
      bundle,
      release: opts.release ?? releaseInfo(),
      base: server.url,
      fetch,
      run: tools.run,
      policy: 'release',
      signal: AbortSignal.timeout(10_000),
      onProgress: () => {},
      onInstalling: () => stages.push('installing'),
      workRoot: work,
      arch: 'arm64',
    })
    return 'ok'
  } catch (err) {
    return err instanceof ReplaceError ? err.reason : `unexpected ${String(err)}`
  } finally {
    await server.close()
    expect(readdirSync(work)).toEqual([])
    expect(tools.mounted()).toBe(false)
  }
}

describe('replaceMacInstall', () => {
  it('stages the verified app next to the installed one and leaves the installed one alone', async () => {
    const bundle = installed()
    const image = appBundle(join(root, 'image', 'Ostia.app'), VERSION)
    const tools = fakeTools(image)

    expect(await replaceWith(bundle, tools)).toBe('ok')

    expect(bundleVersion(bundle)).toBe('0.5.12')
    expect(bundleVersion(stagedBundlePath(bundle))).toBe(VERSION)
    expect(stagedBundlePath(bundle)).toBe(join(root, 'Applications', '.Ostia.app.new'))
    const staged = stagedBundlePath(bundle)
    expect(tools.calls).toContainEqual(['codesign', '--verify', '--deep', '--strict', staged])
    expect(tools.calls).toContainEqual([
      'codesign',
      '--verify',
      '--deep',
      '--strict',
      `-R=${TEAM_REQUIREMENT}`,
      staged,
    ])
    expect(tools.calls).toContainEqual(['spctl', '-a', '-t', 'exec', '-vv', staged])
    const attach = tools.calls.find((c) => c[0] === 'hdiutil' && c[1] === 'attach')
    expect(attach?.slice(1, 6)).toEqual([
      'attach',
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      '-mountpoint',
    ])
    expect(tools.calls.filter((c) => c[0] === 'hdiutil' && c[1] === 'detach')).toHaveLength(1)
  })

  const failures: Array<{
    name: string
    reason: string
    tools: (image: string) => FakeTools
    files?: () => Record<string, Buffer>
    release?: () => ReleaseInfo
    imageVersion?: string
  }> = [
    {
      name: 'a broken signature',
      reason: 'bad-signature',
      tools: (image) => fakeTools(image, { codesign: { code: 1, output: 'invalid signature' } }),
    },
    {
      name: 'another team or identifier',
      reason: 'wrong-team',
      tools: (image) =>
        fakeTools(image, { requirement: { code: 3, output: 'does not satisfy its requirement' } }),
    },
    {
      name: 'a rejected Gatekeeper assessment',
      reason: 'not-notarized',
      tools: (image) => fakeTools(image, { spctl: { code: 3, output: 'rejected' } }),
    },
    {
      name: 'a signed but not notarized app',
      reason: 'not-notarized',
      tools: (image) =>
        fakeTools(image, { spctl: { code: 0, output: 'accepted\nsource=Developer ID\n' } }),
    },
    {
      name: 'another version in Info.plist',
      reason: 'wrong-version',
      tools: (image) => fakeTools(image, { plist: '0.6.0-rc.1' }),
    },
    {
      name: 'another version in build-info.json',
      reason: 'wrong-version',
      tools: (image) => fakeTools(image),
      imageVersion: '0.6.0-rc.1',
    },
    {
      name: 'a dmg that does not mount',
      reason: 'mount-failed',
      tools: (image) => fakeTools(image, { attach: { code: 1, output: 'corrupt image' } }),
    },
    {
      name: 'a copy that fails',
      reason: 'extract-failed',
      tools: (image) => fakeTools(image, { ditto: { code: 1, output: 'no space' } }),
    },
    {
      name: 'a download that does not match SHA256SUMS',
      reason: 'checksum-mismatch',
      tools: (image) => fakeTools(image),
      files: () => ({ ...releaseFiles(), [`${DOWNLOAD}/${DMG}`]: Buffer.from('tampered') }),
    },
    {
      name: 'SHA256SUMS that disagrees with the asset digest',
      reason: 'checksum-mismatch',
      tools: (image) => fakeTools(image),
      release: () => releaseInfo('f'.repeat(64)),
    },
    {
      name: 'a release without an asset digest',
      reason: 'no-checksum',
      tools: (image) => fakeTools(image),
      release: () => ({ version: VERSION, url: '' }),
    },
    {
      name: 'SHA256SUMS without the dmg',
      reason: 'no-checksum',
      tools: (image) => fakeTools(image),
      files: () => ({
        ...releaseFiles(),
        [`${DOWNLOAD}/SHA256SUMS`]: Buffer.from(`${DMG_SHA}  other.dmg\n`),
      }),
    },
  ]

  for (const failure of failures) {
    it(`changes nothing, detaches and cleans up after ${failure.name}`, async () => {
      const bundle = installed()
      const image = appBundle(join(root, 'image', 'Ostia.app'), failure.imageVersion ?? VERSION)
      const tools = failure.tools(image)

      expect(
        await replaceWith(bundle, tools, {
          files: failure.files?.(),
          release: failure.release?.(),
        }),
      ).toBe(failure.reason)

      expect(bundleVersion(bundle)).toBe('0.5.12')
      expect(readdirSync(join(root, 'Applications'))).toEqual(['Ostia.app'])
      expect(readdirSync(join(root, 'work'))).toEqual([])
      const attached = tools.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'attach')
      const detached = tools.calls.some((c) => c[0] === 'hdiutil' && c[1] === 'detach')
      expect(detached).toBe(attached && failure.reason !== 'mount-failed')
    })
  }

  it('refuses before downloading when the bundle cannot be replaced', async () => {
    const bundle = installed()
    mkdirSync(oldBundlePath(bundle))
    const tools = fakeTools(join(root, 'none'))
    expect(await replaceWith(bundle, tools)).toBe('blocked')
    expect(tools.calls).toEqual([])
  })
})

describe('canReplaceBundle', () => {
  it('accepts a writable bundle in a writable folder', async () => {
    expect(await canReplaceBundle(installed(), 'arm64')).toEqual({ ok: true })
  })

  it('refuses an app running translocated or from a mounted disk image, before touching the disk', async () => {
    expect(
      await canReplaceBundle('/private/var/folders/x/T/AppTranslocation/1234/d/Ostia.app', 'arm64'),
    ).toEqual({ ok: false, reason: 'translocated' })
    expect(await canReplaceBundle('/Volumes/Ostia 0.6.0/Ostia.app', 'arm64')).toEqual({
      ok: false,
      reason: 'read-only',
    })
  })

  it('refuses a Mac without an arm64 disk image', async () => {
    expect(await canReplaceBundle(installed(), 'x64')).toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })

  it('refuses a symlinked bundle and a missing one', async () => {
    const bundle = installed()
    const link = join(root, 'Applications', 'Linked.app')
    symlinkSync(bundle, link)
    expect(await canReplaceBundle(link, 'arm64')).toEqual({ ok: false, reason: 'symlink' })
    expect(await canReplaceBundle(join(root, 'Gone.app'), 'arm64')).toEqual({
      ok: false,
      reason: 'not-writable',
    })
  })

  it('names a staged or old copy left by an earlier update', async () => {
    const bundle = installed()
    mkdirSync(stagedBundlePath(bundle))
    expect(await canReplaceBundle(bundle, 'arm64')).toEqual({
      ok: false,
      reason: 'leftover',
      path: stagedBundlePath(bundle),
    })
    await discardStaged(bundle)
    mkdirSync(oldBundlePath(bundle))
    expect(await canReplaceBundle(bundle, 'arm64')).toEqual({
      ok: false,
      reason: 'leftover',
      path: oldBundlePath(bundle),
    })
  })

  it.skipIf(process.getuid?.() === 0)('refuses a folder the user cannot write', async () => {
    const bundle = installed()
    chmodSync(join(root, 'Applications'), 0o555)
    try {
      expect(await canReplaceBundle(bundle, 'arm64')).toEqual({
        ok: false,
        reason: 'not-writable',
      })
    } finally {
      chmodSync(join(root, 'Applications'), 0o755)
    }
  })
})

describe('signaturePolicy', () => {
  it('ignores the ad-hoc switch in a packaged build', () => {
    const env = { OSTIA_UPDATE_SIGNATURE: 'adhoc' }
    expect(signaturePolicy(true, env)).toBe('release')
    expect(signaturePolicy(false, env)).toBe('adhoc')
    expect(signaturePolicy(false, {})).toBe('release')
    expect(signaturePolicy(false, { OSTIA_UPDATE_SIGNATURE: 'none' })).toBe('release')
  })

  it('pins the Developer ID team and the bundle identifier for releases', () => {
    expect(designatedRequirement('release')).toBe(TEAM_REQUIREMENT)
    expect(designatedRequirement('adhoc')).toBe('identifier "ai.aurigax.ostia"')
  })
})

describe('swapStagedBundle', () => {
  const trusted = { verify: () => true }

  it('moves the installed bundle aside and the staged one into place, with spaces in the path', () => {
    const bundle = installed()
    appBundle(stagedBundlePath(bundle), VERSION)
    const checked: string[] = []
    expect(
      swapStagedBundle(bundle, {
        verify: (staged) => {
          checked.push(staged)
          return true
        },
      }),
    ).toBe('swapped')
    expect(checked).toEqual([stagedBundlePath(bundle)])
    expect(bundleVersion(bundle)).toBe(VERSION)
    expect(bundleVersion(oldBundlePath(bundle))).toBe('0.5.12')
    expect(existsSync(stagedBundlePath(bundle))).toBe(false)
  })

  it('does nothing without a staged bundle or with an old one still there', () => {
    const bundle = installed()
    expect(swapStagedBundle(bundle, trusted)).toBe('nothing-staged')
    appBundle(stagedBundlePath(bundle), VERSION)
    mkdirSync(oldBundlePath(bundle))
    expect(swapStagedBundle(bundle, trusted)).toBe('failed')
    expect(bundleVersion(bundle)).toBe('0.5.12')
  })

  it('checks the signature again right before the swap and drops a staged bundle that fails it', () => {
    const bundle = installed()
    appBundle(stagedBundlePath(bundle), VERSION)
    expect(swapStagedBundle(bundle, { verify: () => false })).toBe('rejected')
    expect(bundleVersion(bundle)).toBe('0.5.12')
    expect(readdirSync(join(root, 'Applications'))).toEqual(['Ostia.app'])
  })

  it('drops a staged symlink or file without following it or verifying it', () => {
    const bundle = installed()
    const elsewhere = appBundle(join(root, 'elsewhere', 'Ostia.app'), VERSION)
    const verify = (): boolean => {
      throw new Error('verified a staged entry that is not a folder')
    }
    symlinkSync(elsewhere, stagedBundlePath(bundle))
    expect(swapStagedBundle(bundle, { verify })).toBe('rejected')
    expect(existsSync(stagedBundlePath(bundle))).toBe(false)
    expect(bundleVersion(elsewhere)).toBe(VERSION)
    writeFileSync(stagedBundlePath(bundle), 'not an app')
    expect(swapStagedBundle(bundle, { verify })).toBe('rejected')
    expect(readdirSync(join(root, 'Applications'))).toEqual(['Ostia.app'])
    expect(bundleVersion(bundle)).toBe('0.5.12')
  })

  it('puts the installed bundle back when the staged one cannot be moved in', () => {
    const bundle = installed()
    appBundle(stagedBundlePath(bundle), VERSION)
    let calls = 0
    const rename = (from: string, to: string): void => {
      calls += 1
      if (calls === 2) throw new Error('EXDEV')
      cpSync(from, to, { recursive: true })
      rmSync(from, { recursive: true })
    }
    expect(swapStagedBundle(bundle, { ...trusted, rename })).toBe('failed')
    expect(bundleVersion(bundle)).toBe('0.5.12')
    expect(existsSync(oldBundlePath(bundle))).toBe(false)
  })
})

describe('verifyStagedSync', () => {
  it('fails closed for a folder that is not a signed app', () => {
    const unsigned = appBundle(join(root, 'Unsigned.app'), VERSION)
    expect(verifyStagedSync(unsigned, 'release')).toBe(false)
    expect(verifyStagedSync(unsigned, 'adhoc')).toBe(false)
    expect(verifyStagedSync(join(root, 'missing.app'), 'adhoc')).toBe(false)
  })
})

describe('runCommand', () => {
  it('passes arguments without a shell and reports the exit code', async () => {
    expect(await runCommand('/bin/echo', ['a b; echo c'])).toEqual({
      code: 0,
      output: 'a b; echo c\n',
    })
    expect((await runCommand('/bin/sh', ['-c', 'exit 3'])).code).toBe(3)
    expect((await runCommand(join(root, 'missing'), [])).code).not.toBe(0)
  })
})
