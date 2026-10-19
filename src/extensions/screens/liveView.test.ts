import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { ExtensionCaller, ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { CreateGate } from './createGate'
import { installState } from './install'
import { panelHandlers } from './panelApi'
import { type ScreensPanelServer, startPanelServer } from './panelServer'
import type { OwnedScreen } from './screenRegistry'
import { ScreensService } from './screensService'
import { type FakeScreens, fakeScreens, translate } from './testFake'
import { verbHandlers } from './verbs'
import { Viewers, viewStream } from './viewers'

const novnc = dirname(dirname(createRequire(__filename).resolve('@novnc/novnc')))
const AGENT_WINDOW_MS = 10_000

interface Reply {
  status: number
  body: string
  csp: string | null
}

async function fetchReply(url: string, init?: RequestInit): Promise<Reply> {
  const res = await fetch(url, init)
  return {
    status: res.status,
    body: await res.text(),
    csp: res.headers.get('content-security-policy'),
  }
}

function connectView(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ws: WebSocket; first: Buffer } | { refused: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { origin: new URL(url).origin.replace('ws', 'http'), ...headers },
    })
    ws.once('message', (data: Buffer) => resolve({ ws, first: Buffer.from(data) }))
    ws.once('unexpected-response', (_req, res) => resolve({ refused: res.statusCode ?? 0 }))
    ws.once('error', () => resolve({ refused: -1 }))
  })
}

describe('the live view in the Screens panel', () => {
  let fake: FakeScreens
  let service: ScreensService
  let viewers: Viewers
  let server: ScreensPanelServer
  let now = Date.now()
  let panel: ReturnType<typeof panelHandlers>
  let verbs: ReturnType<typeof verbHandlers>
  const sockets: WebSocket[] = []

  const agent = (workspaceId: string): ExtensionCaller => ({
    kind: 'pane',
    paneId: `pane-${workspaceId}`,
    workspaceId,
    capabilities: [],
  })

  const create = async (workspaceId: string): Promise<OwnedScreen> => {
    const res = await service.create({ workspaceId, allow: [] })
    if (!res.ok) throw new Error(res.message)
    return res.value
  }

  const open = (workspaceId: string) => {
    const page = server.open({ workspaceId, locale: 'en' })
    const url = new URL(page)
    return { page, base: `${url.origin}${url.pathname}`, ws: `ws://${url.host}${url.pathname}` }
  }

  const api = async (base: string, command: string, args: unknown = {}) => {
    const res = await fetch(`${base}api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, args }),
    })
    return (await res.json()) as ExtensionResult & { data?: Record<string, unknown> }
  }

  const view = async (ws: string, id: string) => {
    const res = await connectView(`${ws}view/${id}`)
    if ('refused' in res) throw new Error(`refused ${res.refused}`)
    sockets.push(res.ws)
    return res
  }

  beforeEach(async () => {
    fake = fakeScreens()
    now = Date.now()
    service = new ScreensService()
    viewers = new Viewers()
    const gate = new CreateGate({
      confirm: async () => true,
      card: () => ({ title: 't', message: 'm' }),
    })
    panel = panelHandlers({
      service,
      gate,
      phones: () => null,
      translate,
      viewers,
      now: () => now,
      installState: (reason) => installState(reason, () => true),
      confirm: async () => true,
      openTerminal: async () => ({ ok: true, paneId: 'p' }),
      sandboxDomains: async () => ({ ok: false, error: 'not-sandboxed' }),
    })
    verbs = verbHandlers({
      service,
      gate,
      translate,
      installed: () => true,
      sandboxDomains: async () => ({ ok: false, error: 'not-sandboxed' }),
      workspaceName: async (id) => id,
      agentOf: async () => undefined,
    })
    server = await startPanelServer({
      dir: __dirname,
      files: ['panel.html', 'panel.css'],
      vendor: { dir: novnc, prefix: 'novnc/' },
      handle: async (command, args, scope) =>
        panel[command]?.(args, { ...scope, sandboxed: false }) ?? { ok: false, error: 'unknown' },
      openStream: viewStream(service, viewers),
    })
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    viewers.closeAll()
    await server.close()
    service.stopAllNow()
    fake.restore()
  })

  it('SCX-C4 shows the screen through the loopback page: the view socket carries the screen RFB stream both ways', async () => {
    const screen = await create('A')
    const { ws } = open('A')
    const { ws: socket, first } = await view(ws, screen.id)
    expect(first.toString()).toBe('RFB 003.008\n')
    socket.send(Buffer.from('RFB 003.008\n'))
    const input = join(fake.dir, `view-${screen.id}-v1.in`)
    await expect
      .poll(() => (existsSync(input) ? readFileSync(input, 'utf8') : ''))
      .toBe('RFB 003.008\n')
    expect(fake.calls()).toContain(`view ${screen.id}`)
  })

  it('SCX-C5 opens no stream without the token path, with another Host or Origin, or for a screen of another workspace', async () => {
    const mine = await create('A')
    const theirs = await create('B')
    const { ws } = open('A')
    const host = new URL(ws).host
    const other = `ws://${host}/${'0'.repeat(48)}/`
    const tries = [
      connectView(`ws://${host}/view/${mine.id}`),
      connectView(`${other}view/${mine.id}`),
      connectView(`${ws}view/${theirs.id}`),
      connectView(`${ws}view/nope`),
      connectView(`${ws}view/${mine.id}`, { host: `localhost:${host.split(':')[1]}` }),
      connectView(`${ws}view/${mine.id}`, { origin: 'http://evil.test' }),
    ]
    for (const res of await Promise.all(tries)) expect(res).toHaveProperty('refused')
    expect(fake.calls().filter((c) => c.startsWith('view'))).toEqual([])
  })

  it('SCX-C5 serves only the vendored viewer files under the panel path', async () => {
    const { base } = open('A')
    expect((await fetchReply(`${base}novnc/core/rfb.js`)).status).toBe(200)
    expect((await fetchReply(`${base}novnc/vendor/pako/lib/zlib/inflate.js`)).status).toBe(200)
    for (const path of [
      'novnc/package.json',
      'novnc/README.md',
      'novnc/../ostia.json',
      'novnc/core/',
    ]) {
      expect((await fetchReply(`${base}${path}`)).status, path).toBe(404)
    }
  })

  it('SCX-C6 keeps the viewer and agent tokens out of everything the page loads, and confines the page to its own origin', async () => {
    const screen = await create('A')
    const { base, ws } = open('A')
    await view(ws, screen.id)
    const replies = [
      await fetchReply(base),
      await fetchReply(`${base}panel.css`),
      await fetchReply(`${base}novnc/core/rfb.js`),
      await fetchReply(`${base}api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'state', args: {} }),
      }),
    ]
    for (const reply of replies) {
      expect(reply.status).toBe(200)
      expect(reply.body).not.toContain(screen.viewerToken)
      expect(reply.body).not.toContain(screen.agentToken)
      expect(reply.csp).toMatch(/^default-src 'self'/)
      expect(reply.csp).not.toMatch(/https?:|ws:|\*/)
    }
    const built = [
      join(__dirname, '../../../out/marketplace/extensions/screens/panel.js'),
      join(__dirname, '../../../extensions/screens/panel.js'),
    ].find((file) => existsSync(file))
    expect(built).toBeDefined()
    const script = readFileSync(built as string, 'utf8')
    expect(script).not.toMatch(/(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/)
    expect(fake.calls().join('\n')).not.toMatch(/[0-9a-f]{64}/)
  })

  it('SCX-C7 refuses the agent while the human holds the input, and lets it act again after Give back', async () => {
    const screen = await create('A')
    const { base, ws } = open('A')
    await view(ws, screen.id)
    expect(await api(base, 'takeover', { id: screen.id })).toMatchObject({ ok: true })
    expect(await verbs.click({ argv: ['5', '5'] }, agent('A'))).toMatchObject({
      ok: false,
      message: 'human-owns-input',
    })
    expect(await api(base, 'giveback', { id: screen.id })).toMatchObject({ ok: true })
    expect(await verbs.click({ argv: ['5', '5'] }, agent('A'))).toMatchObject({ ok: true })
  })

  it('SCX-C7 refuses Take over from a panel that has no view of that screen', async () => {
    const screen = await create('A')
    const { base } = open('A')
    expect(await api(base, 'takeover', { id: screen.id })).toMatchObject({ ok: false })
    expect(fake.calls().filter((c) => c.startsWith('takeover'))).toEqual([])
  })

  it('SCX-C9 shows agent driving after the agent acts and drops it 10 s after its last action', async () => {
    const screen = await create('A')
    const { base, ws } = open('A')
    const driving = async () =>
      ((await api(base, 'state')).data?.screens as { agentDriving: boolean }[])[0].agentDriving
    expect(await driving()).toBe(false)
    await verbs.click({ argv: ['1', '1'] }, agent('A'))
    const actedAt = Date.parse(fake.screens()[0].log?.at(-1)?.time ?? '')
    now = actedAt
    expect(await driving()).toBe(true)
    now = actedAt + AGENT_WINDOW_MS - 1000
    expect(await driving()).toBe(true)
    now = actedAt + AGENT_WINDOW_MS + 1000
    expect(await driving()).toBe(false)
    now = Date.now()
    await verbs.click({ argv: ['1', '1'] }, agent('A'))
    await view(ws, screen.id)
    await api(base, 'takeover', { id: screen.id })
    expect(await driving()).toBe(false)
  })
})
