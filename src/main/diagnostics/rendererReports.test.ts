import { describe, expect, it } from 'vitest'
import {
  REPORT_MESSAGE_MAX,
  REPORT_PANE_IDS_MAX,
  REPORT_STACK_MAX,
  ReportLimiter,
  normalizePaneIds,
  normalizeRendererReport,
} from './rendererReports'

describe('normalizeRendererReport', () => {
  it('accepts a known kind with a message, stack and source', () => {
    expect(
      normalizeRendererReport({ kind: 'render', message: 'boom', stack: 'at x', source: 'a.js:1' }),
    ).toEqual({ kind: 'render', message: 'boom', stack: 'at x', source: 'a.js:1' })
  })

  it('refuses unknown kinds, missing messages and non-objects', () => {
    expect(normalizeRendererReport({ kind: 'shell', message: 'x' })).toBeNull()
    expect(normalizeRendererReport({ kind: 'error' })).toBeNull()
    expect(normalizeRendererReport({ kind: 'error', message: 42 })).toBeNull()
    expect(normalizeRendererReport('error')).toBeNull()
    expect(normalizeRendererReport(null)).toBeNull()
    expect(normalizeRendererReport([{ kind: 'error', message: 'x' }])).toBeNull()
  })

  it('clips long text, strips control characters and drops non-string extras', () => {
    const report = normalizeRendererReport({
      kind: 'error',
      message: `a\u0007b${'m'.repeat(REPORT_MESSAGE_MAX * 2)}`,
      stack: 's'.repeat(REPORT_STACK_MAX * 2),
      source: { file: 'x' },
      extra: 'ignored',
    })
    expect(report?.message.startsWith('ab')).toBe(true)
    expect(report?.message.length).toBe(REPORT_MESSAGE_MAX)
    expect(report?.stack?.length).toBe(REPORT_STACK_MAX)
    expect(report).not.toHaveProperty('source')
    expect(report).not.toHaveProperty('extra')
  })

  it('keeps line breaks in a stack', () => {
    expect(normalizeRendererReport({ kind: 'error', message: 'm', stack: 'a\nb' })?.stack).toBe(
      'a\nb',
    )
  })
})

describe('normalizePaneIds', () => {
  it('accepts a list of pane id strings', () => {
    expect(normalizePaneIds(['p1', 'p2', 'p1'])).toEqual(new Set(['p1', 'p2']))
  })

  it('refuses anything else or an oversized list', () => {
    expect(normalizePaneIds('p1')).toBeNull()
    expect(normalizePaneIds(['p1', 3])).toBeNull()
    expect(normalizePaneIds([''])).toBeNull()
    expect(
      normalizePaneIds(Array.from({ length: REPORT_PANE_IDS_MAX + 1 }, (_, i) => `p${i}`)),
    ).toBeNull()
  })
})

describe('ReportLimiter', () => {
  it('allows a burst per key, then drops and reports how many were dropped', () => {
    let now = 0
    const limiter = new ReportLimiter(2, 1000, () => now)
    expect(limiter.take('w1')).toEqual({ allowed: true, suppressed: 0 })
    expect(limiter.take('w1')).toEqual({ allowed: true, suppressed: 0 })
    expect(limiter.take('w1').allowed).toBe(false)
    expect(limiter.take('w1').allowed).toBe(false)
    expect(limiter.take('w2').allowed).toBe(true)
    now = 1000
    expect(limiter.take('w1')).toEqual({ allowed: true, suppressed: 2 })
  })
})
