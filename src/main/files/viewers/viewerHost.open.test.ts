import { describe, expect, it } from 'vitest'
import { DOCUMENT_TEXT_MAX, GESTURE_WINDOW_MS, type ViewerHostDeps } from './viewerHost'
import { adoptGuest, BYTES, FILE, get, OPEN, setup } from './viewerHostHarness'

const SESSION = 'ostia-viewer-office'

function opened(overrides: Partial<ViewerHostDeps> = {}, path = FILE) {
  const harness = setup(overrides)
  const result = harness.host.open('w1', { ...OPEN, path })
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
  const press = (shift = false, key = 'Enter') =>
    guest.emit('before-input-event', {}, { type: 'keyDown', shift, key })
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

  it('opens a link only after Enter or Space, not after any other key', async () => {
    const { open, press } = opened()
    for (const key of ['a', 'Tab', 'ArrowDown', 'c']) {
      press(false, key)
      expect((await open('https://example.com/')).status).toBe(403)
    }
    press(false, ' ')
    expect((await open('https://example.com/')).status).toBe(204)
    press(false, 'Enter')
    expect((await open('https://example.com/')).status).toBe(204)
  })

  it('takes a pointer press or a key press within the window, spends it once and refuses a stale one', async () => {
    const { open, click, press, clock, events } = opened()
    press()
    expect((await open('https://example.com/a')).status).toBe(204)
    expect((await open('https://example.com/a')).status).toBe(403)
    press(true)
    expect((await open('https://example.com/b')).status).toBe(204)
    click()
    clock.now += GESTURE_WINDOW_MS + 1
    expect((await open('https://example.com/')).status).toBe(403)
    press()
    clock.now += GESTURE_WINDOW_MS + 1
    expect((await open('https://example.com/')).status).toBe(403)
    expect(
      events.map((event) => (event.payload as { target: { shift: boolean } }).target.shift),
    ).toEqual([false, true])
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

  it('opens no file for a sandboxed, scratch or remote workspace and still opens web links', async () => {
    const { open, click, events } = opened({ fileLinksAllowed: () => false })
    click()
    expect((await open('notes/b.md')).status).toBe(403)
    click()
    expect((await open('https://example.com/')).status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ payload: { target: { kind: 'url' } } })
  })

  it('asks the workspace of the viewer pane about file links', async () => {
    const asked: string[] = []
    const { open, click } = opened({
      fileLinksAllowed: (paneId) => {
        asked.push(paneId)
        return true
      },
    })
    click()
    await open('notes/b.md')
    expect(asked).toEqual(['p1'])
  })

  it.each(['archive:%2Fhome%2Fu%2Fpack.zip!/docs/a.md', 'remote://host/home/u/a.md'])(
    'opens no relative link beside %s, which is not a plain disk path',
    async (path) => {
      const { open, click, events } = opened(
        {
          confine: (candidate) => candidate,
          viewer: () => ({ dir: '/ext/office', entry: 'sheet.html', builtin: true }),
          statDocument: async () => ({ size: 4, modified: 7 }),
        },
        path,
      )
      click()
      expect((await open('b.md')).status).toBe(403)
      expect(events).toEqual([])
    },
  )

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

describe('/~find-keys', () => {
  it('marks the page as owning the find keys without a gesture, until it reloads', async () => {
    const { host, post, guest, session } = opened()
    const src = 'ostia-viewer://t1/sheet.html'
    const owns = () => host.ownsFindKeys({ getURL: () => src })
    expect(owns()).toBe(false)
    expect((await post('~find-keys', {})).status).toBe(204)
    expect(owns()).toBe(true)
    expect(host.ownsFindKeys({ getURL: () => 'https://example.com/' })).toBe(false)
    expect(host.ownsFindKeys({ getURL: () => 'ostia-viewer://other/x' })).toBe(false)
    guest.emit('did-navigate', {}, src)
    expect(owns()).toBe(false)
    expect((await get(session, 'ostia-viewer://t1/~find-keys')).status).toBe(404)
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
      'event: changed\ndata: replaced\n\n',
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

  it('counts bytes against the cap and falls back to the file when the text grows past it', async () => {
    const { host, session } = opened()
    const served = async () =>
      new Uint8Array(await (await get(session, 'ostia-viewer://t1/~document')).arrayBuffer())
    host.setDocumentText('w1', text('# first'))
    expect(await served()).toEqual(new Uint8Array(Buffer.from('# first')))
    host.setDocumentText('w1', text('x'.repeat(DOCUMENT_TEXT_MAX + 1)))
    expect(await served()).toEqual(new Uint8Array(BYTES))
    host.setDocumentText('w1', text('# again'))
    expect(await served()).toEqual(new Uint8Array(Buffer.from('# again')))
    host.setDocumentText('w1', text('€'.repeat(Math.floor(DOCUMENT_TEXT_MAX / 3) + 1)))
    expect(await served()).toEqual(new Uint8Array(BYTES))
    host.setDocumentText('w1', text('€'.repeat(Math.floor(DOCUMENT_TEXT_MAX / 3))))
    expect((await served()).byteLength).toBe(Math.floor(DOCUMENT_TEXT_MAX / 3) * 3)
  })
})
