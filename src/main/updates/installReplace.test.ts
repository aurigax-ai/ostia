import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ReplaceError,
  allowedHop,
  archiveName,
  canReplaceInstall,
  checkArchive,
  checksumFor,
  createInstallReplacer,
  entryProblem,
  releaseAssetUrl,
  releaseDownloadBase,
  replaceInstall,
  runTar,
  swapInstall,
  sweepOldInstall,
} from './installReplace'

const VERSION = '9.9.9'
const OLD = '1.0.0'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-replace-'))
})

afterEach(() => {
  chmodSync(root, 0o755)
  rmSync(root, { recursive: true, force: true })
})

function appFolder(dir: string, version: string): void {
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'ostia'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(
    join(dir, 'resources', 'build-info.json'),
    JSON.stringify({ version, builtAt: '2026-10-07T00:00:00Z' }),
  )
}

function archive(version: string, edit: (top: string) => void = () => {}): Buffer {
  const stage = mkdtempSync(join(root, 'stage-'))
  const top = join(stage, `ostia-${version}-linux-x64`)
  appFolder(top, version)
  edit(top)
  const file = join(stage, 'out.tar.gz')
  execFileSync('tar', ['-C', stage, '-czf', file, `ostia-${version}-linux-x64`])
  return readFileSync(file)
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface Release {
  url: string
  hits: string[]
  close: () => Promise<void>
}

async function serve(
  files: Record<string, Buffer | { redirect: string } | number>,
): Promise<Release> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    hits.push(path)
    const file = files[path]
    if (typeof file === 'number') {
      res.writeHead(file)
      res.end()
    } else if (file && 'redirect' in file) {
      res.writeHead(302, { location: file.redirect })
      res.end()
    } else if (file) {
      res.writeHead(200, { 'content-length': file.byteLength })
      res.end(file)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const assetPath = (asset: string, version = VERSION): string =>
  `/aurigax-ai/ostia/releases/download/v${version}/${asset}`

function release(data: Buffer, sums?: string): Record<string, Buffer> {
  return {
    [assetPath(archiveName(VERSION))]: data,
    [assetPath('SHA256SUMS')]: Buffer.from(
      sums ?? `${sha(data)}  ${archiveName(VERSION)}\n${'0'.repeat(64)}  other.deb\n`,
    ),
  }
}

function installed(): string {
  const appDir = join(root, 'apps', 'ostia')
  appFolder(appDir, OLD)
  return appDir
}

async function replaceFrom(server: Release, appDir: string, version = VERSION): Promise<void> {
  await replaceInstall({
    appDir,
    version,
    base: server.url,
    fetch,
    tar: runTar,
    signal: AbortSignal.timeout(30_000),
    onProgress: () => {},
    onInstalling: () => {},
  })
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return err instanceof ReplaceError ? err.reason : `unexpected: ${String(err)}`
  }
  return 'resolved'
}

const versionIn = (dir: string): string =>
  JSON.parse(readFileSync(join(dir, 'resources', 'build-info.json'), 'utf8')).version

function untouched(appDir: string): void {
  expect(versionIn(appDir)).toBe(OLD)
  expect(readdirSync(join(appDir, '..')).sort()).toEqual(['ostia'])
}

describe('releaseAssetUrl', () => {
  it('builds the download url from the repository and the parsed version only', () => {
    expect(releaseAssetUrl('https://github.com', '1.2.3', archiveName('1.2.3'))?.href).toBe(
      'https://github.com/aurigax-ai/ostia/releases/download/v1.2.3/ostia-1.2.3-linux-x64.tar.gz',
    )
    expect(releaseAssetUrl('https://github.com', '1.2.3', 'SHA256SUMS')?.pathname).toBe(
      '/aurigax-ai/ostia/releases/download/v1.2.3/SHA256SUMS',
    )
  })

  it('refuses a version that is not plain semver and an asset name with a path', () => {
    expect(releaseAssetUrl('https://github.com', '1.2.3/../../x', 'a')).toBeNull()
    expect(releaseAssetUrl('https://github.com', '1.2.3+sha.1', 'a')).toBeNull()
    expect(releaseAssetUrl('https://github.com', '1.2.3', '../a')).toBeNull()
  })

  it('takes the download base from the env only when unpackaged', () => {
    const env = { OSTIA_RELEASE_DOWNLOAD_BASE_URL: 'http://127.0.0.1:1' }
    expect(releaseDownloadBase(false, env)).toBe('http://127.0.0.1:1')
    expect(releaseDownloadBase(true, env)).toBe('https://github.com')
  })
})

describe('allowedHop', () => {
  it('allows only https on GitHub hosts for the real base', () => {
    const base = 'https://github.com'
    expect(allowedHop(new URL('https://github.com/a'), base)).toBe(true)
    expect(allowedHop(new URL('https://objects.githubusercontent.com/a'), base)).toBe(true)
    expect(allowedHop(new URL('http://github.com/a'), base)).toBe(false)
    expect(allowedHop(new URL('https://evil.example/a'), base)).toBe(false)
    expect(allowedHop(new URL('https://github.com:8443/a'), base)).toBe(false)
    expect(allowedHop(new URL('https://u:p@github.com/a'), base)).toBe(false)
  })
})

describe('checksumFor', () => {
  it('reads the line for the asset in sha256sum format', () => {
    const sum = 'a'.repeat(64)
    expect(checksumFor(`${sum}  x.tar.gz\n`, 'x.tar.gz')).toBe(sum)
    expect(checksumFor(`${sum} *x.tar.gz\n`, 'x.tar.gz')).toBe(sum)
    expect(checksumFor(`${sum}  y.tar.gz\n`, 'x.tar.gz')).toBeNull()
    expect(checksumFor('nothing here', 'x.tar.gz')).toBeNull()
  })
})

describe('entryProblem', () => {
  it('refuses .., absolute paths, special files and links that leave the folder', () => {
    expect(entryProblem({ path: 'top/a/../../x', type: 'File' })).toBe(true)
    expect(entryProblem({ path: '/etc/passwd', type: 'File' })).toBe(true)
    expect(entryProblem({ path: 'top/dev', type: 'CharacterDevice' })).toBe(true)
    expect(entryProblem({ path: 'top/l', type: 'SymbolicLink', linkpath: '/etc' })).toBe(true)
    expect(entryProblem({ path: 'top/l', type: 'SymbolicLink', linkpath: '../x' })).toBe(true)
    expect(entryProblem({ path: 'top/a/l', type: 'SymbolicLink', linkpath: '../../x' })).toBe(true)
    expect(entryProblem({ path: 'top/h', type: 'Link', linkpath: '../x' })).toBe(true)
  })

  it('allows files, folders and links that stay inside', () => {
    expect(entryProblem({ path: 'top/', type: 'Directory' })).toBe(false)
    expect(entryProblem({ path: 'top/a/b', type: 'File' })).toBe(false)
    expect(entryProblem({ path: 'top/a/l', type: 'SymbolicLink', linkpath: '../b' })).toBe(false)
    expect(entryProblem({ path: 'top/h', type: 'Link', linkpath: 'top/a/b' })).toBe(false)
  })

  it('refuses an archive on disk that holds a symlink pointing outside', async () => {
    const data = archive(VERSION, (top) => symlinkSync('../../outside', join(top, 'escape')))
    const file = join(root, 'bad.tar.gz')
    writeFileSync(file, data)
    expect(await failure(checkArchive(file))).toBe('bad-archive')
  })
})

describe('canReplaceInstall', () => {
  it('allows a writable folder of its own', async () => {
    expect(await canReplaceInstall(installed())).toEqual({ ok: true })
  })

  it('refuses a folder under a system path', async () => {
    expect(await canReplaceInstall('/opt/ostia')).toEqual({ ok: false, reason: 'system-path' })
    expect(await canReplaceInstall('/usr/lib/ostia')).toEqual({
      ok: false,
      reason: 'system-path',
    })
  })

  it('refuses a symlinked app folder', async () => {
    const real = installed()
    const link = join(root, 'link')
    symlinkSync(real, link)
    expect(await canReplaceInstall(link)).toEqual({ ok: false, reason: 'symlink' })
  })

  it('names a leftover .new or .old folder', async () => {
    const appDir = installed()
    mkdirSync(`${appDir}.old`)
    expect(await canReplaceInstall(appDir)).toEqual({
      ok: false,
      reason: 'leftover',
      path: `${appDir}.old`,
    })
    rmSync(`${appDir}.old`, { recursive: true })
    mkdirSync(`${appDir}.new`)
    expect(await canReplaceInstall(appDir)).toEqual({
      ok: false,
      reason: 'leftover',
      path: `${appDir}.new`,
    })
  })

  it.skipIf(process.getuid?.() === 0)('refuses a parent folder the user cannot write', async () => {
    const appDir = installed()
    chmodSync(join(appDir, '..'), 0o555)
    try {
      expect(await canReplaceInstall(appDir)).toEqual({ ok: false, reason: 'not-writable' })
    } finally {
      chmodSync(join(appDir, '..'), 0o755)
    }
  })
})

describe('replaceInstall', () => {
  it('downloads, verifies, extracts and swaps, keeping the old build in .old', async () => {
    const appDir = installed()
    const server = await serve(release(archive(VERSION)))
    try {
      await replaceFrom(server, appDir)
    } finally {
      await server.close()
    }
    expect(versionIn(appDir)).toBe(VERSION)
    expect(versionIn(`${appDir}.old`)).toBe(OLD)
    expect(existsSync(`${appDir}.new`)).toBe(false)
    expect(existsSync(`${appDir}.download`)).toBe(false)
  })

  it('leaves the install untouched on a checksum mismatch', async () => {
    const appDir = installed()
    const data = archive(VERSION)
    const server = await serve(release(data, `${'f'.repeat(64)}  ${archiveName(VERSION)}\n`))
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('checksum-mismatch')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('refuses a release without a checksum line for the archive', async () => {
    const appDir = installed()
    const server = await serve(release(archive(VERSION), `${'0'.repeat(64)}  other.deb\n`))
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('no-checksum')
      expect(server.hits).toEqual([assetPath('SHA256SUMS')])
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('refuses a redirect to another origin', async () => {
    const appDir = installed()
    const data = archive(VERSION)
    const server = await serve({
      ...release(data),
      [assetPath(archiveName(VERSION))]: { redirect: 'http://127.0.0.2:9/elsewhere' },
    })
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('redirect-refused')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('follows a redirect on the same origin', async () => {
    const appDir = installed()
    const data = archive(VERSION)
    const server = await serve({
      [assetPath('SHA256SUMS')]: Buffer.from(`${sha(data)}  ${archiveName(VERSION)}\n`),
      [assetPath(archiveName(VERSION))]: { redirect: '/blob' },
      '/blob': data,
    })
    try {
      await replaceFrom(server, appDir)
    } finally {
      await server.close()
    }
    expect(versionIn(appDir)).toBe(VERSION)
  })

  it('refuses an archive holding another version and cleans the staged folder', async () => {
    const appDir = installed()
    const server = await serve(release(archive(VERSION, (top) => appFolder(top, '9.9.8'))))
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('wrong-version')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('refuses an archive whose app binary is not executable', async () => {
    const appDir = installed()
    const server = await serve(
      release(archive(VERSION, (top) => chmodSync(join(top, 'ostia'), 0o644))),
    )
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('not-executable')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('refuses an archive with an escaping symlink before extracting anything', async () => {
    const appDir = installed()
    const data = archive(VERSION, (top) => symlinkSync('/etc', join(top, 'etc')))
    const server = await serve(release(data))
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('bad-archive')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('reports an http error and keeps the install', async () => {
    const appDir = installed()
    const server = await serve({ [assetPath('SHA256SUMS')]: 500 })
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('http-error')
    } finally {
      await server.close()
    }
    untouched(appDir)
  })

  it('does not start while a leftover folder is in the way', async () => {
    const appDir = installed()
    mkdirSync(`${appDir}.old`)
    const server = await serve(release(archive(VERSION)))
    try {
      expect(await failure(replaceFrom(server, appDir))).toBe('blocked')
      expect(server.hits).toEqual([])
    } finally {
      await server.close()
    }
  })
})

describe('swapInstall', () => {
  it('moves the app to .old first, then .new into place', async () => {
    const appDir = installed()
    appFolder(`${appDir}.new`, VERSION)
    await swapInstall(appDir)
    expect(versionIn(appDir)).toBe(VERSION)
    expect(versionIn(`${appDir}.old`)).toBe(OLD)
  })

  it('puts the old app back when the new folder cannot be moved in', async () => {
    const appDir = installed()
    expect(await failure(swapInstall(appDir))).toBe('swap-failed')
    expect(versionIn(appDir)).toBe(OLD)
    expect(existsSync(`${appDir}.old`)).toBe(false)
  })
})

describe('sweepOldInstall', () => {
  it('deletes .old only once the version that replaced it is running', async () => {
    const appDir = installed()
    appFolder(`${appDir}.old`, OLD)
    const pending = { appDir, version: VERSION }
    expect(await sweepOldInstall(pending, appDir, OLD)).toBe(false)
    expect(existsSync(`${appDir}.old`)).toBe(true)
    expect(await sweepOldInstall(pending, join(root, 'other'), VERSION)).toBe(false)
    expect(await sweepOldInstall(null, appDir, VERSION)).toBe(false)
    expect(await sweepOldInstall(pending, appDir, `${VERSION}+sha.abc`)).toBe(true)
    expect(existsSync(`${appDir}.old`)).toBe(false)
  })
})

describe('createInstallReplacer', () => {
  it('runs one replace at a time and reports done with the version it installed', async () => {
    const appDir = installed()
    const server = await serve(release(archive(VERSION)))
    const states: string[] = []
    const replaced: unknown[] = []
    const replacer = createInstallReplacer({
      appDir: () => appDir,
      base: server.url,
      fetch,
      tar: runTar,
      onState: (s) => states.push(s.status),
      onProgress: () => {},
      onReplaced: (p) => replaced.push(p),
    })
    try {
      expect(await replacer.start(VERSION)).toBe('started')
      expect(await replacer.start(VERSION)).toBe('busy')
      await expect.poll(() => replacer.state().status, { timeout: 20_000 }).toBe('done')
    } finally {
      await server.close()
    }
    expect(states).toEqual(['downloading', 'installing', 'done'])
    expect(replaced).toEqual([{ appDir, version: VERSION }])
  })

  it('does nothing without a replaceable app folder', async () => {
    const replacer = createInstallReplacer({
      appDir: () => null,
      base: 'https://github.com',
      fetch,
      tar: runTar,
      onState: () => {},
      onProgress: () => {},
      onReplaced: () => {},
    })
    expect(await replacer.start(VERSION)).toBe('no-action')
  })
})
