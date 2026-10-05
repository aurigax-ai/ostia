import { PICK_RUNTIME_GLOBAL, pickRuntime, pickRuntimeScript } from '@shared/pickRuntime'
import { afterEach, describe, expect, it } from 'vitest'

const FIXTURE = `
  <header>
    <nav aria-label="Main">
      <a href="/">Home</a>
      <a href="/docs">Docs</a>
    </nav>
  </header>
  <main>
    <button id="save" class="btn primary">Save</button>
    <div class="dup" id="twin">one</div>
    <div class="dup" id="twin">two</div>
    <button data-testid="pay-button">Pay</button>
    <button data-testid="row-action">A</button>
    <button data-testid="row-action">B</button>
    <button aria-label="Close dialog">×</button>
    <form><input name="email" placeholder="you@example.com"></form>
    <ul>
      <li>first</li>
      <li><span>second</span></li>
      <li>third</li>
    </ul>
    <section id="card"><p>alpha</p><p>beta</p></section>
    <label for="q">Search</label><input id="q:1" type="search">
  </main>
`

const theme = { accent: '#00d8ff', surface: '#313537', fg: '#e3edf5' }

function runtime() {
  return pickRuntime(window as Window & typeof globalThis)
}

function q(sel: string): Element {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`fixture missing ${sel}`)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  Reflect.deleteProperty(window, PICK_RUNTIME_GLOBAL)
})

describe('selectorFor', () => {
  it('prefers a unique id', () => {
    document.body.innerHTML = FIXTURE
    expect(runtime().selectorFor(q('#save'))).toBe('#save')
  })

  it('prefers data-testid when there is no usable id', () => {
    document.body.innerHTML = FIXTURE
    expect(runtime().selectorFor(q('[data-testid="pay-button"]'))).toBe(
      '[data-testid="pay-button"]',
    )
  })

  it('uses aria-label and form names as anchors', () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    expect(r.selectorFor(q('[aria-label="Close dialog"]'))).toBe(
      'button[aria-label="Close dialog"]',
    )
    expect(r.selectorFor(q('input[name="email"]'))).toBe('input[name="email"]')
  })

  it('skips a duplicated id and falls back to a structural path', () => {
    document.body.innerHTML = FIXTURE
    const second = document.querySelectorAll('.dup')[1]
    const sel = runtime().selectorFor(second)
    expect(sel).not.toContain('#twin')
    expect(document.querySelectorAll(sel)).toHaveLength(1)
    expect(document.querySelector(sel)).toBe(second)
  })

  it('builds an nth-of-type path anchored on the nearest unique ancestor', () => {
    document.body.innerHTML = FIXTURE
    expect(runtime().selectorFor(q('#card p:nth-of-type(2)'))).toBe('#card > p:nth-of-type(2)')
  })

  it('escapes ids that are not plain identifiers', () => {
    document.body.innerHTML = FIXTURE
    const input = document.getElementById('q:1') as Element
    const sel = runtime().selectorFor(input)
    expect(document.querySelector(sel)).toBe(input)
  })

  it('returns a selector that matches exactly the element for every node in the page', () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const sel = r.selectorFor(el)
      const found = document.querySelectorAll(sel)
      expect(found, sel).toHaveLength(1)
      expect(found[0], sel).toBe(el)
    }
  })
})

describe('roleOf / nameOf', () => {
  it('derives implicit roles and accessible names', () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    expect(r.roleOf(q('#save'))).toBe('button')
    expect(r.nameOf(q('#save'))).toBe('Save')
    expect(r.roleOf(q('nav'))).toBe('navigation')
    expect(r.nameOf(q('nav'))).toBe('Main')
    expect(r.roleOf(q('a[href="/docs"]'))).toBe('link')
    expect(r.nameOf(q('input[name="email"]'))).toBe('you@example.com')
  })
})

describe('describe', () => {
  it('captures the page, element html, style subset and viewport', () => {
    document.body.innerHTML = FIXTURE
    document.title = 'Fixture'
    const d = runtime().describe(q('#save'))
    expect(d.title).toBe('Fixture')
    expect(d.url).toBe(window.location.href)
    expect(d.html).toBe('<button id="save" class="btn primary">Save</button>')
    expect(d.label).toMatch(/^button#save\.btn\.primary {2}\d+×\d+$/)
    expect(Object.keys(d.styles)).toContain('display')
    expect(d.viewport.width).toBe(window.innerWidth)
  })

  it('bounds the outerHTML it sends back', () => {
    document.body.innerHTML = `<div id="big">${'x'.repeat(10_000)}</div>`
    expect(runtime().describe(q('#big')).html.length).toBe(4096)
  })
})

describe('start / cancel', () => {
  it('shows an overlay host while active and removes it on cancel', async () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    const pending = r.start(theme)
    expect(r.active()).toBe(true)
    expect(document.querySelector('[data-ostia-pick]')).not.toBeNull()
    r.cancel()
    await expect(pending).resolves.toBeNull()
    expect(r.active()).toBe(false)
    expect(document.querySelector('[data-ostia-pick]')).toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
  })

  it('ignores synthetic events so the page cannot fake a pick or an Escape', async () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    const pending = r.start(theme)
    const save = q('#save')
    save.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(r.active()).toBe(true)
    r.cancel()
    await expect(pending).resolves.toBeNull()
  })

  it('a new start ends the previous one', async () => {
    document.body.innerHTML = FIXTURE
    const r = runtime()
    const first = r.start(theme)
    const second = r.start(theme)
    await expect(first).resolves.toBeNull()
    expect(document.querySelectorAll('[data-ostia-pick]')).toHaveLength(1)
    r.cancel()
    await second
  })
})

describe('pickRuntimeScript', () => {
  it('is self-contained once serialized, and installs itself only once', () => {
    document.body.innerHTML = FIXTURE
    new Function(pickRuntimeScript())()
    const installed = Reflect.get(window, PICK_RUNTIME_GLOBAL)
    expect(installed.selectorFor(q('[data-testid="pay-button"]'))).toBe(
      '[data-testid="pay-button"]',
    )
    new Function(pickRuntimeScript())()
    expect(Reflect.get(window, PICK_RUNTIME_GLOBAL)).toBe(installed)
  })
})
