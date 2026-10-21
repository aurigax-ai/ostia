import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type AddressInfo, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { holdPort } from '../../../../test/heldPort'
import { DEFAULT_CONTROLS } from '../../../shared/sandbox/sandbox'
import { SandboxHost } from '../hostClient'
import { sandboxedShellCommand } from '../ptyWrap'
import { buildSrtConfig } from '../srtConfig'
import { PortBridge } from './portBridge'
import { PortForwarder } from './portForwarder'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-ports.mjs')
let INNER_PORT = 0
let OTHER_PORT = 0
const heldPorts: { port: number; release: () => void }[] = []
const BIG_BODY_BYTES = 2 * 1024 * 1024

let root: string
let host: SandboxHost
let forwarder: PortForwarder
const panes: { process: ChildProcess; bridge: PortBridge | null }[] = []

const POLL = { timeout: 15_000, interval: 100 }

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
  if (process.platform !== 'linux') return
  heldPorts.push(...(await Promise.all([holdPort(), holdPort()])))
  ;[INNER_PORT, OTHER_PORT] = heldPorts.map((held) => held.port).sort((x, y) => x - y)
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@anthropic-ai/sandbox-runtime'],
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
  await vi.waitUntil(() => forwarder.listeners('ws').length === 2, POLL)
  await vi.waitUntil(() => panes.every((pane) => pane.bridge?.connected), POLL)
}, 60_000)

afterAll(() => {
  forwarder?.stopAll()
  for (const held of heldPorts.splice(0)) held.release()
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
      await vi.waitUntil(() => portFree(INNER_PORT), POLL)
    })

    it('never lists the sandbox runtime proxy bridges as servers', () => {
      const ports = forwarder.listeners('ws').map((l) => l.port)
      expect(ports).toEqual([INNER_PORT, OTHER_PORT])
      expect(ports).not.toContain(3128)
      expect(ports).not.toContain(1080)
    })
  },
)
