import { describe, expect, it } from 'vitest'
import { externalHref, findAppLinks, linkKind } from './externalLinks'

const VAULT =
  'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true'
const VAULT_HREF =
  'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD%E6%96%87.md&newpane=true'

describe('externalHref', () => {
  it('opens obsidian and vscode links only when apps are allowed', () => {
    for (const url of [
      'obsidian://open?vault=a',
      'vscode://file/a.ts',
      'vscode-insiders://file/a',
    ]) {
      expect(externalHref(url, { apps: true })).toBe(url)
      expect(externalHref(url, { apps: false })).toBeNull()
    }
  })

  it('keeps web and mail links open under both policies', () => {
    for (const apps of [true, false]) {
      expect(externalHref('https://example.com/a', { apps })).toBe('https://example.com/a')
      expect(externalHref('mailto:a@example.com', { apps })).toBe('mailto:a@example.com')
    }
  })

  it('blocks scripts, files, data and unknown schemes', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<b>x</b>',
      'ssh://host',
      'x-custom://do',
      'not a url',
    ]) {
      expect(externalHref(url, { apps: true })).toBeNull()
    }
  })

  it('encodes spaces and non-ASCII characters without encoding twice', () => {
    expect(externalHref(VAULT, { apps: true })).toBe(VAULT_HREF)
    expect(externalHref(VAULT_HREF, { apps: true })).toBe(VAULT_HREF)
    expect(externalHref('VSCODE://file/My Dir/a.ts:3', { apps: true })).toBe(
      'vscode://file/My%20Dir/a.ts:3',
    )
  })
})

describe('linkKind', () => {
  it('sends web links to the browser and app links to the system', () => {
    expect(linkKind('https://example.com')).toBe('browser')
    expect(linkKind(VAULT)).toBe('external')
    expect(linkKind('vscode://file/a')).toBe('external')
    expect(linkKind('mailto:a@example.com')).toBe('external')
  })

  it('refuses everything else', () => {
    expect(linkKind('javascript:alert(1)')).toBeNull()
    expect(linkKind('file:///etc/passwd')).toBeNull()
    expect(linkKind('x-custom://do')).toBeNull()
    expect(linkKind('')).toBeNull()
  })
})

describe('findAppLinks', () => {
  it('finds a markdown target in angle brackets with spaces and Chinese', () => {
    const text = `see [中文](<${VAULT}>) now`
    const [link] = findAppLinks(text)
    expect(link.url).toBe(VAULT)
    expect(text.slice(link.start, link.end)).toBe(VAULT)
  })

  it('finds plain links and trims trailing punctuation and closing brackets', () => {
    const text = 'open obsidian://open?vault=Notes&file=中文筆記, or (vscode://file/a.ts:12).'
    expect(findAppLinks(text).map((l) => l.url)).toEqual([
      'obsidian://open?vault=Notes&file=中文筆記',
      'vscode://file/a.ts:12',
    ])
  })

  it('stops a plain link at full-width punctuation', () => {
    expect(findAppLinks('打開 obsidian://open?file=筆記（草稿）').map((l) => l.url)).toEqual([
      'obsidian://open?file=筆記',
    ])
  })

  it('keeps a bracket that belongs to the link', () => {
    expect(findAppLinks('[n](vscode://file/a(1).ts)').map((l) => l.url)).toEqual([
      'vscode://file/a(1).ts',
    ])
  })

  it('trims a long run of closing brackets and punctuation in linear time', () => {
    const text = `obsidian://a${')'.repeat(50_000)}`
    const started = performance.now()
    const [closers] = findAppLinks(text)
    expect(performance.now() - started).toBeLessThan(1_000)
    const [mixed] = findAppLinks(`vscode://file/a${'.)]'.repeat(10_000)}`)
    expect(closers.url).toBe('obsidian://a')
    expect(mixed.url).toBe('vscode://file/a')
  }, 60_000)

  it('ignores other schemes and words that only end in a scheme name', () => {
    expect(findAppLinks('https://a.b javascript://x myobsidian://x obsidian://')).toEqual([])
  })
})
