import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTar, makeZip } from '../../../test/fixtures/lsp/archives'
import { envName } from '../../shared/appEnv'
import type {
  LanguageServerArchive,
  LanguageServerFetchFailure,
  LanguageServerRun,
} from '../../shared/languageServers'
import {
  DOWNLOAD_BASE_URL_ENV,
  FetchError,
  ManagedServers,
  type ManagedServersDeps,
  downloadBaseUrl,
} from './managedServers'

const FAKE_BIN = resolve(__dirname, '../../../test/fixtures/lsp/bin')
const URL_PREFIX = 'https://github.com/owner/repo/releases/download/1.0.0/'

let root: string
let dir: string

interface Call {
  url: string
  headers: Record<string, string>
  redirect: string | undefined
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function downloadRun(
  body: Buffer,
  archive: LanguageServerArchive,
  executable: string,
  extra: { sha256?: string; url?: string; version?: string } = {},
): LanguageServerRun {
  return {
    download: {
      program: 'tool',
      version: extra.version ?? '1.0.0',
      assets: {
        'linux-x64': {
          url: extra.url ?? `${URL_PREFIX}tool.bin`,
          sha256: extra.sha256 ?? sha256(body),
          archive,
          executable,
        },
      },
    },
    args: [],
  }
}

function responder(routes: Record<string, () => Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect,
    })
    const route = routes[url]
    return route ? route() : new Response('missing', { status: 404 })
  }) as typeof fetch
  return { fetch: fake, calls }
}

function serving(body: Buffer, url = `${URL_PREFIX}tool.bin`) {
  return responder({
    [url]: () =>
      new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } }),
  })
}

function managed(overrides: Partial<ManagedServersDeps> = {}): ManagedServers {
  return new ManagedServers({
    dir,
    userAgent: 'ostia/9.9.9',
    platform: 'linux-x64',
    findProgram: () => null,
    env: () => ({ PATH: process.env.PATH }),
    ...overrides,
  })
}

async function failure(pending: Promise<unknown>): Promise<LanguageServerFetchFailure | null> {
  try {
    await pending
    return null
  } catch (err) {
    return err instanceof FetchError ? err.reason : null
  }
}

function leftovers(): string[] {
  const found: string[] = []
  const walk = (at: string): void => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else found.push(path.slice(dir.length + 1))
    }
  }
  walk(dir)
  return found
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-managed-')))
  dir = join(root, 'language-servers')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('downloadBaseUrl', () => {
  it('honours the test override only in an unpackaged app', () => {
    const env = { [envName(DOWNLOAD_BASE_URL_ENV)]: 'http://127.0.0.1:9' }
    expect(downloadBaseUrl(false, env)).toBe('http://127.0.0.1:9')
    expect(downloadBaseUrl(true, env)).toBeNull()
    expect(downloadBaseUrl(false, {})).toBeNull()
    expect(downloadBaseUrl(false, { PINE_LSP_DOWNLOAD_BASE_URL: 'http://127.0.0.1:8' })).toBeNull()
  })
})

describe('ManagedServers downloads', () => {
  it('fetches a gzip asset with only a User-Agent, checks it and makes the program executable', async () => {
    const program = Buffer.from('#!/bin/sh\necho tool\n')
    const body = gzipSync(program)
    const { fetch, calls } = serving(body)
    const servers = managed({ fetch })
    const run = downloadRun(body, 'gz', 'tool')
    const progress: number[] = []
    const path = await servers.fetch('ext', 'srv', run, { onProgress: (n) => progress.push(n) })
    expect(path).toBe(join(dir, 'ext', 'srv', '1.0.0', 'tool'))
    expect(readFileSync(path)).toEqual(program)
    expect(statSync(path).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'ext', 'srv', '1.0.0')).mode & 0o777).toBe(0o700)
    expect(calls).toEqual([
      {
        url: `${URL_PREFIX}tool.bin`,
        headers: { 'User-Agent': 'ostia/9.9.9' },
        redirect: 'manual',
      },
    ])
    expect(progress.at(-1)).toBe(100)
    expect(servers.executable('ext', 'srv', run)).toBe(path)
    expect(leftovers()).toEqual(['ext/srv/1.0.0/tool'])
  })

  it('keeps a plain download as the program itself', async () => {
    const body = Buffer.from('#!/bin/sh\necho plain\n')
    const servers = managed({ fetch: serving(body).fetch })
    const path = await servers.fetch('ext', 'srv', downloadRun(body, 'plain', 'tool-linux'))
    expect(readFileSync(path, 'utf8')).toContain('echo plain')
    expect(statSync(path).mode & 0o111).not.toBe(0)
  })

  it('unpacks a tar.gz with its folders and executable bits', async () => {
    const body = gzipSync(
      makeTar([
        { name: 'bin/', type: '5', mode: 0o755 },
        { name: 'bin/tool', data: '#!/bin/sh\n', mode: 0o755 },
        { name: 'share/data.txt', data: 'data' },
      ]),
    )
    const servers = managed({ fetch: serving(body).fetch })
    const path = await servers.fetch('ext', 'srv', downloadRun(body, 'tar.gz', 'bin/tool'))
    expect(path).toBe(join(dir, 'ext', 'srv', '1.0.0', 'bin', 'tool'))
    expect(statSync(path).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(dir, 'ext', 'srv', '1.0.0', 'share', 'data.txt'), 'utf8')).toBe('data')
  })

  it('unpacks a zip with its folders and executable bits', async () => {
    const body = makeZip([
      { name: 'pkg/bin/tool', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: 'pkg/lib/include/a.h', data: 'int a;' },
    ])
    const servers = managed({ fetch: serving(body).fetch })
    const path = await servers.fetch('ext', 'srv', downloadRun(body, 'zip', 'pkg/bin/tool'))
    const base = join(dir, 'ext', 'srv', '1.0.0', 'pkg')
    expect(path).toBe(join(base, 'bin', 'tool'))
    expect(statSync(path).mode & 0o111).not.toBe(0)
    expect(statSync(join(base, 'lib', 'include', 'a.h')).mode & 0o111).toBe(0)
  })

  it('refuses a URL outside the allowed hosts without asking the network', async () => {
    const body = Buffer.from('x')
    const { fetch, calls } = serving(body)
    const servers = managed({ fetch })
    for (const url of [
      'https://evil.example/tool.bin',
      'http://github.com/owner/repo/tool.bin',
      'https://github.com:8443/owner/repo/tool.bin',
      'https://user@github.com/owner/repo/tool.bin',
    ]) {
      expect(
        await failure(servers.fetch('ext', 'srv', downloadRun(body, 'plain', 'tool', { url }))),
      ).toBe('host-not-allowed')
    }
    expect(calls).toEqual([])
    expect(leftovers()).toEqual([])
  })

  it('follows a redirect to an allowed host and refuses one that leaves the list', async () => {
    const body = Buffer.from('#!/bin/sh\n')
    const cdn = 'https://release-assets.githubusercontent.com/asset/1?sig=abc'
    const followed = responder({
      [`${URL_PREFIX}tool.bin`]: () =>
        new Response(null, { status: 302, headers: { location: cdn } }),
      [cdn]: () => new Response(new Uint8Array(body)),
    })
    const servers = managed({ fetch: followed.fetch })
    await servers.fetch('ext', 'ok', downloadRun(body, 'plain', 'tool'))
    expect(followed.calls.map((c) => c.url)).toEqual([`${URL_PREFIX}tool.bin`, cdn])

    for (const location of [
      'https://evil.example/tool',
      'http://github.com/x',
      '/relative/../ok',
    ]) {
      const refused = responder({
        [`${URL_PREFIX}tool.bin`]: () => new Response(null, { status: 302, headers: { location } }),
        'https://github.com/ok': () =>
          new Response(null, { status: 302, headers: { location: 'ftp://github.com/x' } }),
      })
      expect(
        await failure(
          managed({ fetch: refused.fetch }).fetch('ext', 'no', downloadRun(body, 'plain', 'tool')),
        ),
      ).toBe('redirect-refused')
    }
    expect(existsSync(join(dir, 'ext', 'no', '1.0.0'))).toBe(false)
  })

  it('gives up after too many redirects', async () => {
    const body = Buffer.from('x')
    const loop = responder({
      [`${URL_PREFIX}tool.bin`]: () =>
        new Response(null, { status: 302, headers: { location: `${URL_PREFIX}tool.bin` } }),
    })
    expect(
      await failure(
        managed({ fetch: loop.fetch }).fetch('e', 's', downloadRun(body, 'plain', 'tool')),
      ),
    ).toBe('redirect-refused')
    expect(loop.calls).toHaveLength(6)
  })

  it('reports an HTTP error and an unreachable host', async () => {
    const body = Buffer.from('x')
    expect(
      await failure(
        managed({ fetch: responder({}).fetch }).fetch('e', 's', downloadRun(body, 'plain', 't')),
      ),
    ).toBe('http-error')
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(
      await failure(managed({ fetch: offline }).fetch('e', 's', downloadRun(body, 'plain', 't'))),
    ).toBe('offline')
    expect(leftovers()).toEqual([])
  })

  it('stops a download that is larger than the cap, announced or not', async () => {
    const body = Buffer.alloc(4096, 1)
    const run = downloadRun(body, 'plain', 'tool')
    expect(
      await failure(
        managed({ fetch: serving(body).fetch, maxDownloadBytes: 1024 }).fetch('e', 's', run),
      ),
    ).toBe('too-large')
    const unannounced = responder({
      [`${URL_PREFIX}tool.bin`]: () => new Response(new Uint8Array(body)),
    })
    expect(
      await failure(
        managed({ fetch: unannounced.fetch, maxDownloadBytes: 1024 }).fetch('e', 's', run),
      ),
    ).toBe('too-large')
    expect(leftovers()).toEqual([])
  })

  it('leaves nothing behind, and nothing executable, when the checksum does not match', async () => {
    const body = Buffer.from('#!/bin/sh\necho tampered\n')
    const run = downloadRun(body, 'plain', 'tool', { sha256: 'a'.repeat(64) })
    const servers = managed({ fetch: serving(body).fetch })
    expect(await failure(servers.fetch('ext', 'srv', run))).toBe('checksum-mismatch')
    expect(leftovers()).toEqual([])
    expect(servers.executable('ext', 'srv', run)).toBeNull()
  })

  it('refuses an archive entry that leaves the folder or is a link', async () => {
    const outside = join(root, 'evil.txt')
    const bad: [Buffer, LanguageServerArchive][] = [
      [
        gzipSync(
          makeTar([
            { name: '../evil.txt', data: 'x' },
            { name: 'tool', data: 'x' },
          ]),
        ),
        'tar.gz',
      ],
      [gzipSync(makeTar([{ name: 'tool', type: '2', linkName: '/bin/sh' }])), 'tar.gz'],
      [
        gzipSync(
          makeTar([
            { name: `${outside}`, data: 'x' },
            { name: 'tool', data: 'x' },
          ]),
        ),
        'tar.gz',
      ],
      [
        makeZip([
          { name: '../evil.txt', data: 'x' },
          { name: 'tool', data: 'x' },
        ]),
        'zip',
      ],
      [makeZip([{ name: 'tool', data: '/bin/sh', mode: 0o120777 }]), 'zip'],
      [
        makeZip([
          { name: 'dir\\tool', data: 'x' },
          { name: 'tool', data: 'x' },
        ]),
        'zip',
      ],
      [Buffer.from('not an archive'), 'zip'],
      [Buffer.from('not gzip'), 'gz'],
    ]
    for (const [body, archive] of bad) {
      const servers = managed({ fetch: serving(body).fetch })
      expect(await failure(servers.fetch('ext', 'srv', downloadRun(body, archive, 'tool')))).toBe(
        'bad-archive',
      )
    }
    expect(existsSync(outside)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('refuses an archive that unpacks past the size or file caps', async () => {
    const big = gzipSync(makeTar([{ name: 'tool', data: Buffer.alloc(8192) }]))
    expect(
      await failure(
        managed({ fetch: serving(big).fetch, maxExtractBytes: 1024 }).fetch(
          'e',
          's',
          downloadRun(big, 'tar.gz', 'tool'),
        ),
      ),
    ).toBe('too-large')
    const many = makeZip([
      { name: 'tool', data: 'x' },
      { name: 'a', data: 'x' },
      { name: 'b', data: 'x' },
    ])
    expect(
      await failure(
        managed({ fetch: serving(many).fetch, maxExtractFiles: 2 }).fetch(
          'e',
          's',
          downloadRun(many, 'zip', 'tool'),
        ),
      ),
    ).toBe('too-large')
    const bomb = gzipSync(Buffer.alloc(64 * 1024))
    expect(
      await failure(
        managed({ fetch: serving(bomb).fetch, maxExtractBytes: 1024 }).fetch(
          'e',
          's',
          downloadRun(bomb, 'gz', 'tool'),
        ),
      ),
    ).toBe('too-large')
    expect(leftovers()).toEqual([])
  })

  it('fails when the archive does not hold the named executable', async () => {
    const body = makeZip([{ name: 'other', data: 'x' }])
    const servers = managed({ fetch: serving(body).fetch })
    expect(await failure(servers.fetch('e', 's', downloadRun(body, 'zip', 'tool')))).toBe(
      'executable-missing',
    )
    expect(leftovers()).toEqual([])
  })

  it('has nothing to fetch on a platform the manifest names no asset for', () => {
    const run = downloadRun(Buffer.from('x'), 'plain', 'tool')
    expect(managed().canFetch(run)).toBe(true)
    expect(managed({ platform: 'linux-arm64' }).canFetch(run)).toBe(false)
    expect(managed({ platform: 'linux-arm64' }).executable('e', 's', run)).toBeNull()
  })

  it('downloads once when asked twice at the same moment', async () => {
    const body = Buffer.from('#!/bin/sh\n')
    const { fetch, calls } = serving(body)
    const servers = managed({ fetch })
    const run = downloadRun(body, 'plain', 'tool')
    const [a, b] = await Promise.all([servers.fetch('e', 's', run), servers.fetch('e', 's', run)])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
  })

  it('sends requests to the override origin in tests and stays on it', async () => {
    const body = Buffer.from('#!/bin/sh\n')
    const local = 'http://127.0.0.1:4010/owner/repo/releases/download/1.0.0/tool.bin'
    const { fetch, calls } = responder({ [local]: () => new Response(new Uint8Array(body)) })
    const servers = managed({ fetch, baseUrl: 'http://127.0.0.1:4010' })
    await servers.fetch('e', 's', downloadRun(body, 'plain', 'tool'))
    expect(calls.map((c) => c.url)).toEqual([local])
    const away = responder({
      [local]: () =>
        new Response(null, { status: 302, headers: { location: 'https://github.com/x' } }),
    })
    expect(
      await failure(
        managed({ fetch: away.fetch, baseUrl: 'http://127.0.0.1:4010' }).fetch(
          'e',
          't',
          downloadRun(body, 'plain', 'tool'),
        ),
      ),
    ).toBe('redirect-refused')
  })
})

describe('ManagedServers cleanup', () => {
  const body = Buffer.from('#!/bin/sh\n')

  it('drops older versions once a new one is in place', async () => {
    const servers = managed({ fetch: serving(body).fetch })
    await servers.fetch('ext', 'srv', downloadRun(body, 'plain', 'tool', { version: '1.0.0' }))
    await servers.fetch('ext', 'srv', downloadRun(body, 'plain', 'tool', { version: '2.0.0' }))
    expect(readdirSync(join(dir, 'ext', 'srv'))).toEqual(['2.0.0'])
  })

  it('keeps only the pinned version of declared servers and forgets the rest', async () => {
    const servers = managed({ fetch: serving(body).fetch })
    const run = downloadRun(body, 'plain', 'tool')
    await servers.fetch('keep', 'srv', run)
    await servers.fetch('keep', 'gone', run)
    await servers.fetch('old', 'srv', run)
    await servers.fetch('removed', 'srv', run)
    mkdirSync(join(dir, 'keep', 'srv', '.stage-leftover'))
    servers.retain(
      new Map([
        ['keep/srv', '1.0.0'],
        ['old/srv', '2.0.0'],
      ]),
    )
    expect(leftovers()).toEqual(['keep/srv/1.0.0/tool'])
    expect(readdirSync(join(dir, 'keep', 'srv'))).toEqual(['1.0.0'])
    expect(existsSync(join(dir, 'removed'))).toBe(false)
  })

  it('removes one server’s copy, or everything of an uninstalled extension', async () => {
    const servers = managed({ fetch: serving(body).fetch })
    const run = downloadRun(body, 'plain', 'tool')
    await servers.fetch('ext', 'a', run)
    await servers.fetch('ext', 'b', run)
    servers.remove('ext', 'a')
    expect(servers.executable('ext', 'a', run)).toBeNull()
    expect(servers.executable('ext', 'b', run)).not.toBeNull()
    servers.forgetExtension('ext')
    expect(existsSync(join(dir, 'ext'))).toBe(false)
  })
})

describe('ManagedServers go install', () => {
  const run: LanguageServerRun = {
    goInstall: { module: 'example.org/x/tools/gopher', version: 'v1.2.3', binary: 'gopher' },
    args: [],
  }
  let log: string

  function withGo(mode = '', overrides: Partial<ManagedServersDeps> = {}): ManagedServers {
    log = join(root, 'go.log')
    return managed({
      findProgram: (program) => (program === 'go' ? join(FAKE_BIN, 'go') : null),
      env: () => ({
        PATH: process.env.PATH,
        FAKE_GO_LOG: log,
        FAKE_GO_MODE: mode,
        GOFLAGS: '-mod=mod',
      }),
      ...overrides,
    })
  }

  it('runs exactly go install module@version with GOBIN in its own folder and GOFLAGS cleared', async () => {
    const servers = withGo()
    const output: string[] = []
    const path = await servers.fetch('ext', 'gopher', run, {
      onOutput: (line) => output.push(line),
    })
    expect(path).toBe(join(dir, 'ext', 'gopher', 'v1.2.3', 'gopher'))
    expect(statSync(path).mode & 0o111).not.toBe(0)
    const recorded = Object.fromEntries(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    )
    expect(recorded.argv).toBe('install example.org/x/tools/gopher@v1.2.3')
    expect(recorded.GOFLAGS).toBe('[]')
    expect(recorded.ostia_vars).toBe('0')
    expect(recorded.GOBIN).toMatch(/language-servers\/ext\/gopher\/\.stage-/)
    expect(recorded.GOBIN.startsWith(dir)).toBe(true)
    expect(output).toEqual(['go: downloading example.org/x/tools/gopher@v1.2.3'])
    expect(leftovers()).toEqual(['ext/gopher/v1.2.3/gopher'])
    expect(servers.executable('ext', 'gopher', run)).toBe(path)
  })

  it('reports a failed build with redacted output and leaves nothing behind', async () => {
    const servers = withGo('fail')
    const output: string[] = []
    expect(
      await failure(servers.fetch('ext', 'gopher', run, { onOutput: (l) => output.push(l) })),
    ).toBe('command-failed')
    expect(output).toEqual([
      'go: downloading example.org/x/tools v1.2.3',
      'go: build failed token=[redacted]',
    ])
    expect(leftovers()).toEqual([])
  })

  it('stops a go install that takes too long', async () => {
    const servers = withGo('hang', { goTimeoutMs: 200 })
    expect(await failure(servers.fetch('ext', 'gopher', run))).toBe('timeout')
    expect(leftovers()).toEqual([])
  })

  it('fails when go wrote no binary, and when go is not on PATH', async () => {
    expect(await failure(withGo('empty').fetch('ext', 'gopher', run))).toBe('executable-missing')
    const spy = vi.fn()
    const servers = managed({ execFile: spy })
    expect(await failure(servers.fetch('ext', 'gopher', run))).toBe('command-failed')
    expect(spy).not.toHaveBeenCalled()
  })

  it('never passes more than the two fixed arguments or a shell', async () => {
    const calls: { file: string; args: string[]; shell: unknown }[] = []
    const servers = managed({
      findProgram: () => '/usr/bin/go',
      execFile: (file, args, options, callback) => {
        calls.push({ file, args, shell: options.shell })
        writeFileSync(join(options.env.GOBIN as string, 'gopher'), '')
        callback(null, '', '')
      },
    })
    await servers.fetch('ext', 'gopher', run)
    expect(calls).toEqual([
      { file: '/usr/bin/go', args: ['install', 'example.org/x/tools/gopher@v1.2.3'], shell: false },
    ])
  })
})
