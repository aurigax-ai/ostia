import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox'
import { SandboxHost } from './hostClient'
import { PortForwarder, findNamespacePid } from './portForwarder'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-ports.mjs')
const INNER_PORT = 38471

let root: string
let host: SandboxHost
let inner: ChildProcess
let forwarder: PortForwarder

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  ms = 15_000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - start > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function get(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/`)
  return res.text()
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe: Server = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-ports-')))
  const workDir = join(root, 'home', 'proj')
  mkdirSync(workDir, { recursive: true })
  host = new SandboxHost({ nodePath: process.execPath, hostScript, onAsk: async () => false })
  await host.start(
    buildSrtConfig(
      { allowRead: [], domains: [], controls: DEFAULT_CONTROLS },
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
  const server = `require('http').createServer((q,r)=>r.end('INSIDE-${INNER_PORT}')).listen(${INNER_PORT},'127.0.0.1')`
  const wrapped = await host.wrap(`${process.execPath} -e "${server}"`, 'bash')
  inner = spawn('/bin/sh', ['-c', wrapped], { cwd: workDir, stdio: 'ignore', detached: true })
  forwarder = new PortForwarder({ pidsOf: () => (inner.pid ? [inner.pid] : []) })
  await until(() => (findNamespacePid([inner.pid ?? 0]) ? true : undefined))
  await until(async () => {
    const pid = findNamespacePid([inner.pid ?? 0])
    return pid && forwarder.listeners('ws').some((l) => l.port === INNER_PORT) ? true : undefined
  })
}, 60_000)

afterAll(() => {
  forwarder?.stopAll()
  if (inner?.pid) {
    try {
      process.kill(-inner.pid, 'SIGKILL')
    } catch {}
  }
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('PortForwarder', () => {
  it('SBX-C45 forwards host 127.0.0.1:<port> to the same port inside the sandbox', async () => {
    await expect(fetch(`http://127.0.0.1:${INNER_PORT}/`)).rejects.toThrow()
    await expect(forwarder.expose('ws', INNER_PORT)).resolves.toEqual({
      ok: true,
      port: INNER_PORT,
    })
    expect(await get(INNER_PORT)).toBe(`INSIDE-${INNER_PORT}`)
    expect(forwarder.exposed('ws')).toEqual([INNER_PORT])
  })

  it('SBX-C46 refuses to expose a port already in use on the host and forwards nothing', async () => {
    const busy = createServer().listen(INNER_PORT + 1, '127.0.0.1')
    await new Promise((r) => busy.once('listening', r))
    try {
      await expect(forwarder.expose('ws', INNER_PORT + 1)).resolves.toEqual({
        ok: false,
        error: 'port-in-use',
      })
      expect(forwarder.exposed('ws')).not.toContain(INNER_PORT + 1)
    } finally {
      busy.close()
    }
  })

  it('SBX-C47 releases the host port when the workspace closes', async () => {
    if (!forwarder.exposed('ws').includes(INNER_PORT)) await forwarder.expose('ws', INNER_PORT)
    expect(await portFree(INNER_PORT)).toBe(false)
    await forwarder.forget('ws')
    expect(forwarder.exposed('ws')).toEqual([])
    expect(await until(async () => ((await portFree(INNER_PORT)) ? true : undefined))).toBe(true)
  })

  it('never lists the sandbox runtime proxy bridges as servers', () => {
    const ports = forwarder.listeners('ws').map((l) => l.port)
    expect(ports).toContain(INNER_PORT)
    expect(ports).not.toContain(3128)
    expect(ports).not.toContain(1080)
  })
})
