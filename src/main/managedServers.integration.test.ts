import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LanguageServerRun } from '../shared/languageServers'
import { FetchError, ManagedServers } from './managedServers'

const program = Buffer.from('#!/bin/sh\necho fetched\n')
const asset = gzipSync(program)
const ASSET_PATH = '/owner/repo/releases/download/1.0.0/tool.gz'

let server: Server
let baseUrl: string
let root: string
const requests: { url: string; headers: IncomingHttpHeaders }[] = []

function run(
  path = ASSET_PATH,
  sha256 = createHash('sha256').update(asset).digest('hex'),
): LanguageServerRun {
  return {
    download: {
      program: 'tool',
      version: '1.0.0',
      assets: {
        'linux-x64': {
          url: `https://github.com${path}`,
          sha256,
          archive: 'gz',
          executable: 'tool',
        },
      },
    },
    args: [],
  }
}

function managed(dir: string): ManagedServers {
  return new ManagedServers({
    dir,
    userAgent: 'ostia/1.2.3',
    platform: 'linux-x64',
    baseUrl,
    findProgram: () => null,
    env: () => ({}),
  })
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-managed-http-')))
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (req.url === ASSET_PATH) {
      res.writeHead(200, { 'content-length': asset.length })
      res.end(asset)
    } else if (req.url === '/redirect/inside') {
      res.writeHead(302, { location: ASSET_PATH })
      res.end()
    } else if (req.url === '/redirect/outside') {
      res.writeHead(302, { location: 'https://github.com/owner/repo/tool.gz' })
      res.end()
    } else {
      res.writeHead(404)
      res.end('missing')
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((done) => server.close(done))
  rmSync(root, { recursive: true, force: true })
})

describe('ManagedServers against a local HTTP server', () => {
  it('downloads, verifies and unpacks an asset, identifying itself only by a User-Agent', async () => {
    requests.length = 0
    const dir = join(root, 'ok')
    const path = await managed(dir).fetch('ext', 'srv', run())
    expect(readFileSync(path)).toEqual(program)
    expect(statSync(path).mode & 0o111).not.toBe(0)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(ASSET_PATH)
    expect(requests[0].headers['user-agent']).toBe('ostia/1.2.3')
    for (const header of ['cookie', 'authorization', 'referer', 'origin']) {
      expect(requests[0].headers[header]).toBeUndefined()
    }
  })

  it('follows a redirect that stays on the same origin and refuses one that leaves it', async () => {
    const sha = createHash('sha256').update(asset).digest('hex')
    const inside = await managed(join(root, 'inside')).fetch(
      'ext',
      'srv',
      run('/redirect/inside', sha),
    )
    expect(readFileSync(inside)).toEqual(program)
    await expect(
      managed(join(root, 'outside')).fetch('ext', 'srv', run('/redirect/outside', sha)),
    ).rejects.toMatchObject({ reason: 'redirect-refused' })
  })

  it('reports a missing asset and a tampered one without keeping anything', async () => {
    const missing = managed(join(root, 'missing')).fetch('ext', 'srv', run('/nope'))
    await expect(missing).rejects.toBeInstanceOf(FetchError)
    await expect(missing).rejects.toMatchObject({ reason: 'http-error', detail: '404' })
    const tampered = managed(join(root, 'tampered'))
    await expect(
      tampered.fetch('ext', 'srv', run(ASSET_PATH, 'b'.repeat(64))),
    ).rejects.toMatchObject({
      reason: 'checksum-mismatch',
    })
    expect(tampered.executable('ext', 'srv', run(ASSET_PATH, 'b'.repeat(64)))).toBeNull()
  })
})
