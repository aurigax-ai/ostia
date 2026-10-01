import {
  BROWSE_RUNTIME_GLOBAL,
  type BrowseRuntime,
  browseRuntime,
  browseRuntimeScript,
} from '@shared/browseRuntime'
import { formatSnapshot } from '@shared/browseSnapshot'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStorage } from '../../../test/mocks/memoryStorage'

const FIXTURE = `
  <header><nav aria-label="Main"><a href="/docs">Docs</a></nav></header>
  <main>
    <h1>Welcome</h1>
    <p>Some <b>intro</b> text</p>
    <div style="display:none"><button>Hidden</button></div>
    <div aria-hidden="true"><button>Also hidden</button></div>
    <form>
      <label for="email">Email</label><input id="email" type="email" value="a@b.c">
      <label><input id="remember" type="checkbox"> Remember me</label>
      <input type="password" placeholder="Password" value="secret">
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <button id="go" disabled>Submit</button>
      <div id="custom" onclick="void 0">Custom action</div>
      <input type="search" placeholder="Search docs" data-testid="search">
    </form>
    <img src="x.png" alt="Logo">
    <ul><li class="item">one</li><li class="item">two</li><li class="item">three</li></ul>
  </main>
`

let rt: BrowseRuntime

function setup(): BrowseRuntime {
  document.body.innerHTML = FIXTURE
  rt = browseRuntime(window as Window & typeof globalThis)
  return rt
}

function snapshotText(options = {}): string {
  const result = rt.snapshot(null)
  if (!result.ok) throw new Error(result.error)
  return formatSnapshot(result.tree, options).snapshot
}

function installStorage(): { local: Storage; session: Storage } {
  const local = new MemoryStorage()
  const session = new MemoryStorage()
  Object.defineProperty(window, 'localStorage', { value: local, configurable: true })
  Object.defineProperty(window, 'sessionStorage', { value: session, configurable: true })
  return { local, session }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('browseRuntime.snapshot', () => {
  it('builds an aria tree with implicit roles, names, states and refs', () => {
    setup()
    const text = snapshotText()
    expect(text).toContain('- banner [ref=')
    expect(text).toMatch(/- navigation "Main" \[ref=e\d+\]/)
    expect(text).toMatch(/- link "Docs" \[ref=e\d+\]/)
    expect(text).toMatch(/- heading "Welcome" \[ref=e\d+\] \[level=1\]/)
    expect(text).toContain('- text: Some intro text')
    expect(text).toMatch(/- textbox "Email" \[ref=e\d+\]: a@b\.c/)
    expect(text).toMatch(/- checkbox "Remember me" \[ref=e\d+\]/)
    expect(text).toMatch(/- combobox \[ref=e\d+\]: Small/)
    expect(text).toMatch(/- button "Submit" \[ref=e\d+\] \[disabled\]/)
    expect(text).toMatch(/- generic "Custom action" \[ref=e\d+\]/)
    expect(text).toMatch(/- searchbox "Search docs" \[ref=e\d+\]/)
    expect(text).toMatch(/- img "Logo" \[ref=e\d+\]/)
    expect(text).toMatch(/- listitem \[ref=e\d+\]\n\s+- text: one/)
  })

  it('leaves out hidden and aria-hidden elements and password values', () => {
    setup()
    const text = snapshotText()
    expect(text).not.toContain('Hidden')
    expect(text).not.toContain('Also hidden')
    expect(text).not.toContain('secret')
    expect(text).toMatch(/- textbox "Password" \[ref=e\d+\]$/m)
  })

  it('keeps the same ref for an element across snapshots', () => {
    setup()
    const first = snapshotText()
    const second = snapshotText()
    expect(second).toBe(first)
  })

  it('scopes to a selector', () => {
    setup()
    const result = rt.snapshot('form')
    expect(result.ok).toBe(true)
    const text = result.ok ? formatSnapshot(result.tree).snapshot : ''
    expect(text.split('\n')[0]).toMatch(/^- form \[ref=e\d+\]$/)
    expect(text).not.toContain('Welcome')
    expect(rt.snapshot('#missing')).toEqual({ ok: false, error: 'not-found', message: '#missing' })
  })
})

describe('browseRuntime targets', () => {
  it('resolves @refs from a snapshot, css, text= and xpath=', () => {
    setup()
    const snap = rt.snapshot(null)
    const refs = snap.ok ? formatSnapshot(snap.tree).refs : {}
    const submitRef = Object.entries(refs).find(([, r]) => r.name === 'Submit')?.[0]
    expect(rt.resolve(`@${submitRef}`)).toBe(document.getElementById('go'))
    expect(rt.resolve(submitRef ?? '')).toBe(document.getElementById('go'))
    expect(rt.resolve('#email')).toBe(document.getElementById('email'))
    expect(rt.resolve('text=Custom action')).toBe(document.getElementById('custom'))
    expect(rt.resolve('xpath=//select')).toBe(document.getElementById('size'))
    expect(rt.resolve('@e999')).toBeNull()
    expect(rt.resolve('::not a selector')).toBeNull()
  })
})

describe('browseRuntime actions', () => {
  it('focuses a text field with the caret at the end so typing appends', () => {
    setup()
    const note = document.createElement('input')
    note.value = 'abc'
    document.body.append(note)
    note.setSelectionRange(0, 0)
    note.id = 'note'
    expect(rt.focus('#note')).toEqual({ ok: true })
    expect(document.activeElement).toBe(note)
    expect(note.selectionStart).toBe(3)
  })

  it('fills a field and fires input and change', () => {
    setup()
    const seen: string[] = []
    const email = document.getElementById('email') as HTMLInputElement
    email.addEventListener('input', () => seen.push('input'))
    email.addEventListener('change', () => seen.push('change'))
    expect(rt.fill('#email', 'new@x.test')).toEqual({ ok: true })
    expect(email.value).toBe('new@x.test')
    expect(seen).toEqual(['input', 'change'])
    expect(rt.fill('h1', 'x')).toMatchObject({ ok: false, error: 'not-editable' })
  })

  it('selects an option by value or by visible label', () => {
    setup()
    expect(rt.select('#size', ['Large'])).toEqual({ ok: true, values: ['l'] })
    expect((document.getElementById('size') as HTMLSelectElement).value).toBe('l')
    expect(rt.select('#size', ['s'])).toEqual({ ok: true, values: ['s'] })
    expect(rt.select('#size', ['XL'])).toMatchObject({ ok: false, error: 'no-option' })
  })

  it('reads values with get and states with is', () => {
    setup()
    expect(rt.get('title', null, null)).toEqual({ ok: true, value: document.title })
    expect(rt.get('attr', '#email', 'type')).toEqual({ ok: true, value: 'email' })
    expect(rt.get('value', '#email', null)).toEqual({ ok: true, value: 'a@b.c' })
    expect(rt.get('count', '.item', null)).toEqual({ ok: true, value: 3 })
    expect(rt.get('html', 'h1', null)).toEqual({ ok: true, value: 'Welcome' })
    expect(rt.get('text', '#nope', null)).toMatchObject({ ok: false, error: 'not-found' })
    expect(rt.is('enabled', '#go')).toEqual({ ok: true, value: false })
    expect(rt.is('checked', '#remember')).toEqual({ ok: true, value: false })
    expect(rt.is('visible', 'h1')).toEqual({ ok: true, value: true })
  })

  it('finds elements by role and name, label, placeholder, test id and index', () => {
    setup()
    const refOf = (q: Parameters<BrowseRuntime['find']>[0]): Element | null => {
      const found = rt.find(q)
      return found.ok ? rt.resolve(`@${found.ref}`) : null
    }
    expect(refOf({ by: 'role', value: 'button', name: 'submit' })).toBe(
      document.getElementById('go'),
    )
    expect(refOf({ by: 'role', value: 'button', name: 'submit', exact: true })).toBeNull()
    expect(refOf({ by: 'label', value: 'Email' })).toBe(document.getElementById('email'))
    expect(refOf({ by: 'placeholder', value: 'Search' })).toBe(
      document.querySelector('[data-testid=search]'),
    )
    expect(refOf({ by: 'testid', value: 'search' })).toBe(
      document.querySelector('[data-testid=search]'),
    )
    expect(refOf({ by: 'nth', value: '.item', index: -1 })?.textContent).toBe('three')
    expect(refOf({ by: 'text', value: 'Custom' })).toBe(document.getElementById('custom'))
  })

  it('waits on element state and text', () => {
    setup()
    expect(rt.hasState('h1', 'visible')).toBe(true)
    expect(rt.hasState('#gone', 'detached')).toBe(true)
    expect(rt.hasState('#gone', 'hidden')).toBe(true)
    expect(rt.hasText('Welcome')).toBe(true)
    expect(rt.hasText('Goodbye')).toBe(false)
  })

  it('reads and edits web storage for the page origin', () => {
    const { local, session } = installStorage()
    setup()
    local.setItem('theme', 'dark')
    session.setItem('cart', '3')
    expect(rt.storage()).toEqual({
      origin: window.location.origin,
      local: { theme: 'dark' },
      session: { cart: '3' },
    })
    expect(rt.setStorage('local', 'theme', 'light')).toEqual({ ok: true })
    expect(rt.removeStorage('session', 'cart')).toEqual({ ok: true })
    expect(local.getItem('theme')).toBe('light')
    expect(session.length).toBe(0)
    expect(rt.clearStorage('local')).toEqual({ ok: true })
    expect(local.length).toBe(0)
  })
})

describe('browseRuntimeScript', () => {
  it('is self-contained once serialized, and keeps its refs when installed again', () => {
    document.body.innerHTML = FIXTURE
    new Function(browseRuntimeScript())()
    const installed = Reflect.get(window, BROWSE_RUNTIME_GLOBAL) as BrowseRuntime
    const found = installed.find({ by: 'role', value: 'heading' })
    expect(found.ok).toBe(true)
    new Function(browseRuntimeScript())()
    expect(Reflect.get(window, BROWSE_RUNTIME_GLOBAL)).toBe(installed)
    expect(found.ok && installed.resolve(`@${found.ref}`)?.textContent).toBe('Welcome')
    Reflect.deleteProperty(window, BROWSE_RUNTIME_GLOBAL)
  })
})
