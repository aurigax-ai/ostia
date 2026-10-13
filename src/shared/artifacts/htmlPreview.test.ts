import { describe, expect, it } from 'vitest'
import {
  PREVIEW_PAGE_CSP,
  type PreviewError,
  allowsPreviewRequest,
  blockedByPolicy,
  blockedHost,
  isComponentPath,
  isPreviewPartition,
  isPreviewPath,
  isWebLink,
  keepErrors,
  normalizePreviewTheme,
  previewErrorLine,
  previewPartition,
  shellCsp,
} from './htmlPreview'

describe('preview policy', () => {
  it('runs scripts with an opaque origin and nothing remote', () => {
    const directives = PREVIEW_PAGE_CSP.split('; ')
    expect(directives).toContain("default-src 'none'")
    expect(directives).toContain('sandbox allow-scripts')
    expect(directives).toContain('connect-src ostia-preview:')
    expect(directives).toContain("worker-src 'none'")
    expect(directives).toContain("frame-src 'none'")
    expect(directives).toContain("form-action 'none'")
    expect(directives).toContain("base-uri 'none'")
    expect(PREVIEW_PAGE_CSP).not.toContain('allow-same-origin')
    expect(PREVIEW_PAGE_CSP).not.toContain('unsafe-eval')
    expect(PREVIEW_PAGE_CSP).not.toMatch(/https?:|\*/)
  })

  it('lets a session load only its own scheme', () => {
    expect(allowsPreviewRequest('ostia-preview://abc/')).toBe(true)
    expect(allowsPreviewRequest('ostia-preview://abc/data.json')).toBe(true)
    for (const url of [
      'http://127.0.0.1:8080/',
      'https://example.com/a.js',
      'ws://127.0.0.1:1/',
      'wss://example.com/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'ostia-previewx://abc/',
      'chrome://settings',
    ]) {
      expect(allowsPreviewRequest(url), url).toBe(false)
    }
  })

  it('uses a partition that is never persisted', () => {
    expect(previewPartition('abc')).toBe('ostia-preview-abc')
    expect(previewPartition('abc').startsWith('persist:')).toBe(false)
    expect(isPreviewPartition('ostia-preview-abc')).toBe(true)
    expect(isPreviewPartition('persist:ostia-browser')).toBe(false)
    expect(isPreviewPartition(undefined)).toBe(false)
  })

  it('previews .html, .htm, .jsx and .tsx', () => {
    expect(isPreviewPath('/a/page.html')).toBe(true)
    expect(isPreviewPath('/a/PAGE.HTM')).toBe(true)
    expect(isPreviewPath('/a/page.html.md')).toBe(false)
    expect(isPreviewPath('/a/App.tsx')).toBe(true)
    expect(isPreviewPath('/a/App.jsx')).toBe(true)
    expect(isPreviewPath('/a/lib.ts')).toBe(false)
    expect(isComponentPath('/a/App.tsx')).toBe(true)
    expect(isComponentPath('/a/page.html')).toBe(false)
    expect(isPreviewPath(undefined)).toBe(false)
  })
})

describe('preview errors', () => {
  it('names the host a policy refusal was for, in both wordings Chromium uses', () => {
    expect(
      blockedByPolicy(
        'Refused to connect to \'http://127.0.0.1:4000/fetch\' because it violates the following Content Security Policy directive: "connect-src ostia-preview:".',
      ),
    ).toBe('127.0.0.1:4000')
    expect(
      blockedByPolicy(
        'Loading the image \'https://example.com/a.png\' violates the following Content Security Policy directive: "img-src ostia-preview: data: blob:".',
      ),
    ).toBe('example.com')
    expect(
      blockedByPolicy(
        "Fetch API cannot load http://127.0.0.1:40583/from-component. Refused to connect because it violates the document's Content Security Policy.",
      ),
    ).toBe('127.0.0.1:40583')
    expect(blockedByPolicy("Uncaught ReferenceError: x is not defined at 'http://a/'")).toBeNull()
    expect(
      blockedByPolicy(
        "Refused to create a worker from 'ostia-preview://abc/w.js' because it violates the following Content Security Policy directive",
      ),
    ).toBeNull()
  })

  it('names a host, or the scheme when there is none', () => {
    expect(blockedHost('wss://example.com:9/x')).toBe('example.com:9')
    expect(blockedHost('file:///etc/passwd')).toBe('file')
  })

  it('keeps the newest 8 KiB of messages', () => {
    const error = (message: string): PreviewError => ({ kind: 'error', message })
    let kept: PreviewError[] = []
    for (let i = 0; i < 10; i += 1) kept = keepErrors(kept, error(`${i}`.repeat(1000)), 4000)
    expect(kept.map((e) => e.message[0])).toEqual(['6', '7', '8', '9'])
    expect(keepErrors([], error('x'.repeat(9000)), 4000)[0].message).toHaveLength(4000)
  })

  it('adds the position an error has', () => {
    expect(
      previewErrorLine({
        kind: 'error',
        message: 'Uncaught Error: boom',
        source: 'page.html',
        line: 12,
      }),
    ).toBe('Uncaught Error: boom (page.html:12)')
    expect(previewErrorLine({ kind: 'error', message: 'no position' })).toBe('no position')
    expect(previewErrorLine({ kind: 'error', message: 'line only', line: 3 })).toBe(
      'line only (line 3)',
    )
  })

  it('offers the browser pane only for web links', () => {
    expect(isWebLink('https://example.com/')).toBe(true)
    expect(isWebLink('HTTP://example.com/')).toBe(true)
    expect(isWebLink('file:///etc/passwd')).toBe(false)
    expect(isWebLink('javascript:alert(1)')).toBe(false)
  })
})

describe('the component shell', () => {
  it('allows scripts by nonce only, and nothing else the page policy forbids', () => {
    const csp = shellCsp('abc123')
    expect(csp).toContain("script-src ostia-preview: 'nonce-abc123'")
    expect(csp).not.toContain("script-src ostia-preview: 'unsafe-inline'")
    expect(csp).toContain("style-src ostia-preview: 'unsafe-inline'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain('connect-src ostia-preview:')
  })

  it('takes only --ostia-* names with plain values from the window', () => {
    expect(
      normalizePreviewTheme({
        dark: true,
        vars: {
          '--ostia-bg': '#1d2022',
          '--ostia-font': 'Inter, "Noto Sans", sans-serif',
          '--ostia-fg': 'oklch(0.9 0.01 240)',
          '--other': 'red',
          '--ostia-x': 'red;}</style><script>alert(1)</script>',
          '--ostia-url': 'url(http://example.com/a.png)',
          '--ostia-n': 5,
        },
      }),
    ).toEqual({
      dark: true,
      vars: {
        '--ostia-bg': '#1d2022',
        '--ostia-font': 'Inter, "Noto Sans", sans-serif',
        '--ostia-fg': 'oklch(0.9 0.01 240)',
      },
    })
    expect(normalizePreviewTheme(null)).toEqual({ dark: false, vars: {} })
    expect(normalizePreviewTheme({ dark: 'yes', vars: 'x' })).toEqual({ dark: false, vars: {} })
  })
})
