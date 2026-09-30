import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-dns.mjs')

let root: string
let workDir: string
let host: SandboxHost
let server: Server
let port: number

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  server = createServer((_req, res) => res.end('HOST-LOOPBACK-SERVICE'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-dns-')))
  workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: ['localtest.me'], controls: DEFAULT_CONTROLS },
      {
        home: join(root, 'home'),
        workDir,
        tmpDir: join(root, 'tmp'),
        dataDirs: [],
        socketPath: join(root, 'pine.sock'),
        runtimeReads: [],
      },
    ),
  )
}, 60_000)

afterAll(() => {
  host?.stop()
  server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('sandbox DNS guard', () => {
  it('SBX-C37 blocks an allowed name whose address is this machine', async () => {
    const wrapped = await host.wrap(
      `curl -s -m 20 http://localtest.me:${port}/; echo; curl -s -m 20 -o /dev/null -w "code=%{http_code}\\n" http://localtest.me:${port}/`,
      'bash',
    )
    const out = await new Promise<string>((resolve) => {
      const child = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir })
      let text = ''
      child.stdout.on('data', (d: Buffer) => {
        text += d.toString('utf8')
      })
      child.on('close', () => resolve(text))
    })
    expect(out).not.toContain('HOST-LOOPBACK-SERVICE')
    expect(out).not.toContain('code=200')
  }, 60_000)
})
