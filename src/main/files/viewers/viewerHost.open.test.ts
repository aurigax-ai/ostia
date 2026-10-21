import { describe, expect, it } from 'vitest'
import { DOCUMENT_TEXT_MAX, GESTURE_WINDOW_MS } from './viewerHost'
import { adoptGuest, BYTES, FILE, get, OPEN, setup } from './viewerHostHarness'

const SESSION = 'ostia-viewer-office'

function opened() {
  const harness = setup()
  const result = harness.host.open('w1', OPEN)
  if (!result.ok) throw new Error('not opened')
  const session = harness.sessions.get(SESSION)
  const guest = adoptGuest(harness.host, session, result.src)
  const post = (path: string, body: unknown) =>
    get(session, `ostia-viewer://t1/${path}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const click = (modifiers: string[] = []) =>
    guest.emit('input-event', {}, { type: 'mouseDown', modifiers })
  const press = () => guest.emit('before-input-event', {}, { type: 'keyDown' })
  const open = (href: unknown) => post('~open', { href })
  return { ...harness, session, guest, post, click, press, open }
}

describe('/~open', () => {
  it('needs a trusted pointer input on that guest and spends it', async () => {
    const { open, click, events } = opened()
    expect((await open('https://example.com/a')).status).toBe(403)
    click()
    expect((await open('https://example.com/a')).status).toBe(204)
    expect((await open('https://example.com/a')).status).toBe(403)
    expect(events).toEqual([
      {
        windowId: 'w1',
        type: 'open-link',
        payload: {
          paneId: 'p1',
          target: { kind: 'url', href: 'https://example.com/a', shift: false },
        },
      },
    ])
  })

  it('tells the window whether Shift was held at the press', async () => {
    const { open, click, events } = opened()
    click(['shift'])
    await open('https://example.com/a')
    click(['control'])
    await open('https://example.com/b')
    expect(
      events.map((event) => (event.payload as { target: { shift: boolean } }).target.shift),
    ).toEqual([true, false])
  })

  it('does not accept a key press or a stale pointer input', async () => {
    const { open, click, press, clock, events } = opened()
    press()
    expect((await open('https://example.com/')).status).toBe(403)
    click()
    clock.now += GESTURE_WINDOW_MS + 1
    expect((await open('https://example.com/')).status).toBe(403)
    expect(events).toEqual([])
  })

  it('allows http, https and mailto and refuses every other scheme and form', async () => {
    const { open, click, events } = opened()
    for (const href of [
      'http://example.com/',
      'https://example.com/x?y#z',
      'mailto:a@example.com',
    ]) {
      click()
      expect((await open(href)).status).toBe(204)
    }
    const refused = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'blob:ostia-viewer://t1/x',
      'ostia-viewer://t1/~document',
      'obsidian://open?vault=x',
      'vscode://file/etc/passwd',
      'C:\\Windows\\win.ini',
      '//evil.example/x',
      '\\\\host\\share\\x',
      '/etc/passwd',
      '',
    ]
    for (const href of refused) {
      click()
      expect((await open(href)).status, href).toBe(href === '' ? 400 : 403)
    }
    expect(events).toHaveLength(3)
  })

  it('opens a relative path only through confine, beside the document', async () => {
    const { open, click, events } = opened()
    click()
    expect((await open('notes/b.md?x=1#top')).status).toBe(204)
    expect(events.at(-1)).toMatchObject({
      payload: { target: { kind: 'file', path: '/home/u/notes/b.md' } },
    })
    for (const href of ['../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', '%zz', '#top']) {
      click()
      expect((await open(href)).status, href).toBe(403)
    }
    expect(events).toHaveLength(1)
  })

  it('refuses a body that is not a href', async () => {
    const { post, click } = opened()
    click()
    expect((await post('~open', 'not json')).status).toBe(400)
    expect((await post('~open', { href: 5 })).status).toBe(400)
    expect((await post('~open', { href: 'x'.repeat(5000) })).status).toBe(400)
  })
})

describe('/~edit-source', () => {
  it('needs a pointer or key input on that guest and tells the owner window', async () => {
    const { post, click, press, events } = opened()
    expect((await post('~edit-source', {})).status).toBe(403)
    click()
    expect((await post('~edit-source', {})).status).toBe(204)
    expect((await post('~edit-source', {})).status).toBe(403)
    press()
    expect((await post('~edit-source', {})).status).toBe(204)
    expect(events.map((e) => ({ windowId: e.windowId, type: e.type, payload: e.payload }))).toEqual(
      [
        { windowId: 'w1', type: 'edit-source', payload: { paneId: 'p1' } },
        { windowId: 'w1', type: 'edit-source', payload: { paneId: 'p1' } },
      ],
    )
  })
})

describe('live document text', () => {
  const text = (value: string | null, overrides = {}) => ({
    paneId: 'p1',
    path: FILE,
    text: value,
    ...overrides,
  })

  it('serves the editor text instead of the file and says the document changed', async () => {
    const { host, session } = opened()
    const events = await get(session, 'ostia-viewer://t1/~events')
    const reader = events.body?.getReader()
    if (!reader) throw new Error('no stream')
    await reader.read()
    host.setDocumentText('w1', text('# unsaved'))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      'event: changed\ndata: 1\n\n',
    )
    expect(await (await get(session, 'ostia-viewer://t1/~document')).text()).toBe('# unsaved')
    const meta = await (await get(session, 'ostia-viewer://t1/~meta')).json()
    expect(meta.size).toBe(9)
    host.setDocumentText('w1', text(null))
    expect(
      new Uint8Array(await (await get(session, 'ostia-viewer://t1/~document')).arrayBuffer()),
    ).toEqual(new Uint8Array(BYTES))
  })

  it('takes text only from the owner window, for the token own path, within the cap', async () => {
    const { host, session } = opened()
    const served = async () => (await get(session, 'ostia-viewer://t1/~document')).text()
    host.setDocumentText('w2', text('other window'))
    host.setDocumentText('w1', text('other path', { path: '/home/u/other.xlsx' }))
    host.setDocumentText('w1', text('other pane', { paneId: 'p2' }))
    host.setDocumentText('w1', text('x'.repeat(DOCUMENT_TEXT_MAX + 1)))
    host.setDocumentText('w1', { paneId: 'p1', path: FILE, text: 5 })
    host.setDocumentText('w1', null)
    expect(new Uint8Array(Buffer.from(await served(), 'latin1'))).toEqual(new Uint8Array(BYTES))
  })
})
