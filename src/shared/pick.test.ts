import { describe, expect, it } from 'vitest'
import {
  type CaptureExtras,
  PICK_HTML_MAX,
  PICK_LOG_MAX,
  type PickCapture,
  type RawPick,
  normalizeCapture,
  pickBusMessage,
  renderPickReport,
  reportReference,
  screenshotRect,
} from './pick'

const raw: RawPick = {
  url: 'http://localhost:5173/checkout',
  title: 'Checkout',
  selector: '[data-testid="pay"]',
  label: 'button.primary  120×32',
  html: '<button data-testid="pay" class="primary">Pay</button>',
  box: { x: 10.123, y: 20, width: 120, height: 32 },
  viewport: { width: 800, height: 600 },
  styles: { display: 'inline-block', color: 'rgb(0, 0, 0)', 'not-a-prop': 'x' },
  role: 'button',
  name: 'Pay',
}

const extras = (over: Partial<CaptureExtras> = {}): CaptureExtras => ({
  id: 'pick-1',
  consoleErrors: [],
  failedRequests: [],
  screenshotPath: '/tmp/pine-reports-1000/pick-1.png',
  capturedAt: new Date('2026-09-28T10:00:00Z'),
  ...over,
})

describe('normalizeCapture', () => {
  it('keeps the element facts and rounds the box', () => {
    const c = normalizeCapture(raw, extras())
    expect(c.selector).toBe('[data-testid="pay"]')
    expect(c.box).toEqual({ x: 10.12, y: 20, width: 120, height: 32 })
    expect(c.role).toBe('button')
    expect(c.capturedAt).toBe('2026-09-28T10:00:00.000Z')
    expect(c.htmlTruncated).toBe(false)
  })

  it('drops style properties outside the allowed subset', () => {
    const c = normalizeCapture(raw, extras())
    expect(c.styles).toEqual({ display: 'inline-block', color: 'rgb(0, 0, 0)' })
  })

  it('truncates outerHTML to the cap and flags it', () => {
    const c = normalizeCapture({ ...raw, html: `<div>${'x'.repeat(5000)}</div>` }, extras())
    expect(c.html).toHaveLength(PICK_HTML_MAX)
    expect(c.htmlTruncated).toBe(true)
  })

  it('keeps only the most recent console errors and failed requests', () => {
    const consoleErrors = Array.from({ length: 50 }, (_, i) => ({
      level: 'error',
      text: `e${i}`,
      ts: i,
    }))
    const failedRequests = Array.from({ length: 30 }, (_, i) => ({
      url: `http://x/${i}`,
      method: 'GET',
      status: 500,
      ts: i,
    }))
    const c = normalizeCapture(raw, extras({ consoleErrors, failedRequests }))
    expect(c.consoleErrors).toHaveLength(PICK_LOG_MAX)
    expect(c.consoleErrors.at(-1)?.text).toBe('e49')
    expect(c.failedRequests).toHaveLength(PICK_LOG_MAX)
    expect(c.failedRequests[0].url).toBe('http://x/10')
  })

  it('survives missing or hostile fields from the page', () => {
    const c = normalizeCapture(
      { url: 'u'.repeat(2000), box: { x: Number.NaN } as never, styles: 'nope' as never },
      extras({ screenshotPath: null }),
    )
    expect(c.url.length).toBeLessThanOrEqual(500)
    expect(c.box).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(c.styles).toEqual({})
    expect(c.selector).toBe('')
    expect(c.screenshotPath).toBeNull()
  })
})

describe('screenshotRect', () => {
  it('clips the element box to the viewport and scales by zoom', () => {
    expect(
      screenshotRect({ x: -10, y: 5, width: 50, height: 20 }, { width: 800, height: 600 }, 2),
    ).toEqual({ x: 0, y: 10, width: 80, height: 40 })
  })

  it('returns null when the element is entirely off screen', () => {
    expect(
      screenshotRect({ x: 0, y: 700, width: 50, height: 20 }, { width: 800, height: 600 }, 1),
    ).toBeNull()
  })
})

function capture(over: Partial<PickCapture> = {}): PickCapture {
  return { ...normalizeCapture(raw, extras()), ...over }
}

describe('renderPickReport', () => {
  it('contains the note, selector, page, screenshot path, style and html', () => {
    const md = renderPickReport(capture(), '  The Pay button is cut off  ')
    expect(md).toContain('# UI issue: button.primary  120×32')
    expect(md).toContain('The Pay button is cut off')
    expect(md).toContain('- Selector: `[data-testid="pay"]`')
    expect(md).toContain('Checkout — http://localhost:5173/checkout')
    expect(md).toContain('- Screenshot: /tmp/pine-reports-1000/pick-1.png')
    expect(md).toContain('- display: inline-block')
    expect(md).toContain('```html\n<button data-testid="pay" class="primary">Pay</button>\n```')
  })

  it('lists console errors and failed requests with their outcome', () => {
    const md = renderPickReport(
      capture({
        consoleErrors: [{ level: 'error', text: 'TypeError: x is undefined', ts: 0 }],
        failedRequests: [
          { url: 'http://api/cart', method: 'POST', status: 502, ts: 0 },
          { url: 'http://cdn/font.woff2', method: 'GET', error: 'net::ERR_FAILED', ts: 0 },
        ],
      }),
      'broken',
    )
    expect(md).toContain('`TypeError: x is undefined`')
    expect(md).toContain('POST `http://api/cart` → HTTP 502')
    expect(md).toContain('GET `http://cdn/font.woff2` → net::ERR_FAILED')
  })

  it('says so when nothing was recorded and no note was given', () => {
    const md = renderPickReport(capture({ screenshotPath: null }), '   ')
    expect(md).toContain('(no note)')
    expect(md.match(/None recorded\./g)).toHaveLength(2)
    expect(md).toContain('(not captured: element off screen)')
  })

  it('lengthens the fence when the html itself contains backticks', () => {
    const md = renderPickReport(capture({ html: '<pre>```js</pre>' }), 'x')
    expect(md).toContain('````html\n<pre>```js</pre>\n````')
  })
})

describe('pickBusMessage', () => {
  it('is JSON an agent can parse', () => {
    const msg = JSON.parse(pickBusMessage(capture(), ' fix it ', '/tmp/r/ui-issue-1.md'))
    expect(msg).toEqual({
      kind: 'ui-issue',
      report: '/tmp/r/ui-issue-1.md',
      url: 'http://localhost:5173/checkout',
      selector: '[data-testid="pay"]',
      note: 'fix it',
    })
  })
})

describe('reportReference', () => {
  it('prefixes @ and ends with a space so the user can keep typing', () => {
    expect(reportReference('/tmp/pine-reports-1000/ui-issue-3.md')).toBe(
      '@/tmp/pine-reports-1000/ui-issue-3.md ',
    )
  })

  it('quotes a path containing whitespace', () => {
    expect(reportReference('/tmp/my dir/ui-issue-1.md')).toBe('@"/tmp/my dir/ui-issue-1.md" ')
  })
})
