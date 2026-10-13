import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type AddressInfo, type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONTROLS } from '../../shared/sandbox/sandbox'
import { SandboxHost } from './hostClient'
import { PortBridge } from './portBridge'
import { PortForwarder } from './portForwarder'
import { sandboxedShellCommand } from './ptyWrap'
import { buildSrtConfig } from './srtConfig'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-ports.mjs')
let INNER_PORT = 0
let OTHER_PORT = 0
const BIG_BODY_BYTES = 2 * 1024 * 1024

let root: string
let host: SandboxHost
let forwarder: PortForwarder
const panes: { process: ChildProcess; bridge: PortBridge | null }[] = []

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

function freePorts(count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const probes = Array.from({ length: count }, () => createServer())
    Promise.all(
      probes.map(
        (probe) =>
          new Promise<number>((done, fail) => {
            probe.once('error', fail)
            probe.listen(0, '127.0.0.1', () => done((probe.address() as AddressInfo).port))
          }),
      ),
    )
      .then((ports) => {
        let closed = 0
        for (const probe of probes) {
          probe.close(() => {
            if (++closed === count) resolve(ports.sort((a, b) => a - b))
          })
        }
      })
      .catch(reject)
  })
}

beforeAll(async () => {
  if (process.platform !== 'linux') return
  ;[INNER_PORT, OTHER_PORT] = await freePorts(2)
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-ports-')))
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
        socketPath: join(root, 'ostia.sock'),
        runtimeReads: [],
      },
    ),
  )
  for (const port of [INNER_PORT, OTHER_PORT]) {
    const server = `require('http').createServer((q,r)=>r.end(q.url==='/big'?'x'.repeat(${BIG_BODY_BYTES}):'INSIDE-${port}')).listen(${port},'127.0.0.1')`
    const bridge = await PortBridge.open(join(root, 'tmp'))
    const wrapped = await host.wrap(
      sandboxedShellCommand(
        `${process.execPath} -e "${server}"`,
        undefined,
        null,
        bridge?.command ?? null,
      ),
      'bash',
    )
    const inner = spawn('/bin/sh', ['-c', wrapped], {
      cwd: workDir,
      stdio: 'ignore',
      detached: true,
    })
    panes.push({ process: inner, bridge })
  }
  forwarder = new PortForwarder({
    panesOf: () => panes.map((pane) => ({ pid: pane.process.pid ?? 0, bridge: pane.bridge })),
    unixSocketsOff: () => false,
  })
  await until(() => (forwarder.listeners('ws').length === 2 ? true : undefined))
  await until(() => (panes.every((pane) => pane.bridge?.connected) ? true : undefined))
}, 60_000)

afterAll(() => {
  forwarder?.stopAll()
  for (const pane of panes) {
    pane.bridge?.close()
    try {
      if (pane.process.pid) process.kill(-pane.process.pid, 'SIGKILL')
    } catch {}
  }
  host?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')(
  'PortForwarder (Linux only: /proc and the socat bridge)',
  () => {
    it('SBX-C45 forwards host 127.0.0.1:<port> to the same port inside the sandbox', async () => {
      await expect(fetch(`http://127.0.0.1:${INNER_PORT}/`)).rejects.toThrow()
      await expect(forwarder.expose('ws', INNER_PORT)).resolves.toEqual({
        ok: true,
        port: INNER_PORT,
      })
      expect(await get(INNER_PORT)).toBe(`INSIDE-${INNER_PORT}`)
      expect(forwarder.exposed('ws')).toEqual([INNER_PORT])
    })

    it('reaches a server in another terminal of the workspace, which has a network namespace of its own', async () => {
      expect(forwarder.listeners('ws').map((l) => l.port)).toEqual([INNER_PORT, OTHER_PORT])
      await expect(forwarder.expose('ws', OTHER_PORT)).resolves.toEqual({
        ok: true,
        port: OTHER_PORT,
      })
      expect(await get(OTHER_PORT)).toBe(`INSIDE-${OTHER_PORT}`)
      expect(await get(INNER_PORT)).toBe(`INSIDE-${INNER_PORT}`)
      await forwarder.unexpose('ws', OTHER_PORT)
    })

    it('carries large responses on parallel connections whole', async () => {
      const bodies = await Promise.all(
        Array.from({ length: 8 }, async () =>
          (await fetch(`http://127.0.0.1:${INNER_PORT}/big`)).text(),
        ),
      )
      expect(bodies.map((body) => body.length)).toEqual(Array(8).fill(BIG_BODY_BYTES))
    })

    it('SBX-C46 refuses to expose a port already in use on the host and forwards nothing', async () => {
      const busy = createServer().listen(0, '127.0.0.1')
      await new Promise((r) => busy.once('listening', r))
      const busyPort = (busy.address() as AddressInfo).port
      try {
        await expect(forwarder.expose('ws', busyPort)).resolves.toEqual({
          ok: false,
          error: 'port-in-use',
        })
        expect(forwarder.exposed('ws')).not.toContain(busyPort)
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
      expect(ports).toEqual([INNER_PORT, OTHER_PORT])
      expect(ports).not.toContain(3128)
      expect(ports).not.toContain(1080)
    })
  },
)
