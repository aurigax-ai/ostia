import { EventEmitter } from 'node:events'
import { PORTABLE_TABLES_BYTES_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { describe, expect, it, vi } from 'vitest'
import { type ViewerGuest, viewerOwner } from './viewerHost'
import { adoptGuest, BYTES, FILE, fakeSession, get, OPEN, setup } from './viewerHostHarness'
import { VIEWER_PAGE_CSP } from './viewerSessions'
import { VIEWER_LIMITS } from './viewerWatch'

describe('ViewerHost', () => {
  it('opens a viewer only for the owner window, a known viewer and a confined path', () => {
    const { host, watched } = setup()
    expect(host.open('w2', OPEN)).toEqual({ ok: false, error: 'denied' })
    expect(host.open('w1', { ...OPEN, viewType: 'office.nope' })).toEqual({
      ok: false,
      error: 'unknown-viewer',
    })
    expect(host.open('w1', { ...OPEN, path: '/etc/x.xlsx' })).toEqual({
      ok: false,
      error: 'denied',
    })
    expect(host.open('w1', OPEN)).toEqual({
      ok: true,
      src: 'ostia-viewer://t1/sheet.html',
      partition: 'ostia-viewer-office',
    })
    expect(watched).toEqual([`${viewerOwner('t1')} ${FILE}`])
  })

  it('serves the page, the meta and the bytes with the viewer policy, and nothing else', async () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const session = sessions.get('ostia-viewer-office')
    const page = await get(session, 'ostia-viewer://t1/sheet.html')
    expect(await page.text()).toBe('<html>')
    expect(page.headers.get('content-security-policy')).toBe(VIEWER_PAGE_CSP)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const meta = await (await get(session, 'ostia-viewer://t1/~meta')).json()
    expect(meta).toEqual({
      name: 'report.xlsx',
      size: 4,
      modified: 7,
      locale: 'zh-Hant',
      viewType: 'office.spreadsheet',
    })
    const body = await get(session, 'ostia-viewer://t1/~document')
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array(BYTES))
    expect((await get(session, 'ostia-viewer://t1/..%2F..%2Fetc%2Fpasswd')).status).toBe(404)
    expect((await get(session, 'ostia-viewer://t9/~document')).status).toBe(404)
    expect((await get(session, 'ostia-viewer://t1/~document', { method: 'PUT' })).status).toBe(405)
  })

  it('keeps one extension partition from reading another extension document', async () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const office = sessions.get('ostia-viewer-office')
    const other = fakeSession()
    expect(office).toBeDefined()
    await expect(
      host.serve('csv', new Request('ostia-viewer://t1/~document')),
    ).resolves.toHaveProperty('status', 404)
    expect(other.handler).toBeNull()
  })

  it('says how large a file is that it will not serve', async () => {
    const { host, sessions } = setup({
      readDocument: async () => ({ ok: false, status: 413 }),
    })
    host.open('w1', OPEN)
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~document')
    expect(res.status).toBe(413)
    expect(res.headers.get('x-ostia-size')).toBe('4')
  })

  it('stops serving when the extension is disabled and when the pane closes', async () => {
    const { host, sessions, disable, unwatched } = setup()
    host.open('w1', OPEN)
    const session = sessions.get('ostia-viewer-office')
    disable()
    expect((await get(session, 'ostia-viewer://t1/~document')).status).toBe(410)
    host.close('w1', 'p1')
    expect((await get(session, 'ostia-viewer://t1/~document')).status).toBe(404)
    expect(unwatched).toEqual([`${viewerOwner('t1')} ${FILE}`])
  })

  it('tells the page when its file changes', async () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~events')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no stream')
    await reader.read()
    host.changed(viewerOwner('t1'))
    host.changed('w1')
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('event: changed\ndata: 1\n\n')
    host.forgetWindow('w1')
    expect((await reader.read()).done).toBe(true)
  })

  it('stops the viewer of a guest past its memory limit, tells its window and ends its token', () => {
    const { host, deps, sessions, stopped, killed, memory, unwatched } = setup()
    const opened = host.open('w1', OPEN)
    if (!opened.ok) throw new Error('not opened')
    const guest = Object.assign(new EventEmitter(), {
      session: sessions.get('ostia-viewer-office'),
      setWindowOpenHandler: () => {},
      setWebRTCIPHandlingPolicy: () => {},
      isDestroyed: () => false,
      getOSProcessId: () => 9,
      executeJavaScript: () => Promise.resolve(0),
    })
    expect(host.adopt(guest as unknown as ViewerGuest)).toBe(true)
    guest.emit('did-navigate', {}, opened.src)
    memory.bytes = VIEWER_LIMITS.memoryBytes + 1
    deps.guests.measure()
    deps.guests.tick()
    deps.guests.dispose()
    expect(killed).toEqual([9])
    expect(stopped).toEqual([{ windowId: 'w1', paneId: 'p1', reason: 'memory' }])
    expect(unwatched).toEqual([`${viewerOwner('t1')} ${FILE}`])
  })

  it('lets a viewer page reload itself and refuses every other navigation', () => {
    const { host, sessions } = setup()
    const opened = host.open('w1', OPEN)
    if (!opened.ok) throw new Error('open failed')
    const guest = adoptGuest(host, sessions.get('ostia-viewer-office'), opened.src)
    const attempt = (url: string): boolean => {
      const event = { url, preventDefault: vi.fn() }
      guest.emit('will-navigate', event)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(attempt(opened.src)).toBe(false)
    expect(attempt('https://example.com/')).toBe(true)
    expect(attempt(`${opened.src}#other`)).toBe(true)
  })

  it('ends the viewers of a window when its page reloads, not on an in-page navigation', () => {
    const { host, unwatched } = setup()
    const contents = new EventEmitter()
    host.followReloads(contents, 'w1')
    host.open('w1', OPEN)
    contents.emit('did-start-navigation', {}, 'app://index.html#x', true, true)
    contents.emit('did-start-navigation', {}, 'https://frame', false, false)
    expect(unwatched).toEqual([])
    contents.emit('did-start-navigation', {}, 'app://index.html', false, true)
    expect(unwatched).toHaveLength(1)
  })

  it('keeps only well-formed text tables a page publishes for the portable file', async () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const session = sessions.get('ostia-viewer-office')
    const post = (body: unknown): Promise<Response> =>
      get(session, 'ostia-viewer://t1/~portable', { method: 'POST', body: JSON.stringify(body) })
    expect((await post({ tables: [{ name: 'S', columns: ['A'], rows: [[1]] }] })).status).toBe(400)
    expect((await post({ tables: 'x' })).status).toBe(400)
    expect(host.portable('w1', FILE)).toBeNull()
    const tables = { tables: [{ name: 'S', columns: ['A'], rows: [['1']] }] }
    expect((await post(tables)).status).toBe(204)
    expect(host.portable('w1', FILE)).toEqual(tables)
    expect(host.portable('w2', FILE)).toBeNull()
    expect(host.portable('w1', '/home/u/other.xlsx')).toBeNull()
    const oversize = {
      tables: [{ name: 'S', columns: ['A'], rows: [['x'.repeat(PORTABLE_TABLES_BYTES_MAX)]] }],
    }
    expect((await post(oversize)).status).toBe(413)
    expect(host.portable('w1', FILE)).toBe('too-large')
  })

  it('stops reading a portable body that has no length and grows past the cap', async () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const chunk = new Uint8Array(4 * 1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const res = await get(sessions.get('ostia-viewer-office'), 'ostia-viewer://t1/~portable', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(PORTABLE_TABLES_BYTES_MAX + 16 * chunk.byteLength)
  })

  it('lets only the exact page of the owner window attach in the viewer partition', () => {
    const { host } = setup()
    host.open('w1', OPEN)
    const src = 'ostia-viewer://t1/sheet.html'
    expect(host.acceptsAttach('ostia-viewer-office', src, 'w1')).toBe(true)
    expect(host.acceptsAttach('ostia-viewer-office', src, 'w2')).toBe(false)
    expect(host.acceptsAttach('ostia-viewer-csv', src, 'w1')).toBe(false)
    expect(host.acceptsAttach('ostia-viewer-office', 'ostia-viewer://t1/other.html', 'w1')).toBe(
      false,
    )
    expect(host.acceptsAttach('ostia-ext-office', src, 'w1')).toBe(false)
  })

  it('cancels every request off the viewer scheme and denies every permission', () => {
    const { host, sessions } = setup()
    host.open('w1', OPEN)
    const session = sessions.get('ostia-viewer-office')
    const cancelled = (url: string): boolean => {
      let result = false
      session?.filter?.({ url }, (r) => {
        result = r.cancel
      })
      return result
    }
    expect(cancelled('http://127.0.0.1:9999/x')).toBe(true)
    expect(cancelled('https://example.com/')).toBe(true)
    expect(cancelled('file:///etc/passwd')).toBe(true)
    expect(cancelled('ostia-preview://x/')).toBe(true)
    expect(cancelled('ostia-viewer://t1/sheet.js')).toBe(false)
    expect(cancelled('data:image/png;base64,AA==')).toBe(false)
    const granted = vi.fn()
    session?.permission?.(null, 'clipboard-read', granted)
    expect(granted).toHaveBeenCalledWith(false)
  })

  it('lets a page decode media and wasm and fetch nothing else off the viewer scheme', () => {
    expect(VIEWER_PAGE_CSP).toContain("media-src 'self' blob:")
    expect(VIEWER_PAGE_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(VIEWER_PAGE_CSP).toContain("connect-src 'self'")
    expect(VIEWER_PAGE_CSP).toContain("default-src 'none'")
  })
})
