import { describe, expect, it } from 'vitest'
import { appLinkScheme, browserPageOf, externalHref, findAppLinks, linkKind } from './externalLinks'

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
      'not a url',
    ]) {
      expect(externalHref(url, { apps: true })).toBeNull()
    }
  })

  it('opens any other scheme with a double slash only when apps are allowed', () => {
    for (const url of ['slack://channel?id=1', 'zed://file/tmp/a', 'x-custom://do', 'ssh://host']) {
      expect(externalHref(url, { apps: true })).toBe(url)
      expect(externalHref(url, { apps: false })).toBeNull()
    }
    expect(externalHref('Zed://file/My Dir/a', { apps: true })).toBe('zed://file/My%20Dir/a')
  })

  it('refuses dangerous and internal schemes in any form', () => {
    for (const url of [
      'javascript://x%0Aalert(1)',
      'JAVASCRIPT://x',
      'vbscript://x',
      'data://x',
      'blob://x',
      'about://blank',
      'chrome-extension://abc/x',
      'devtools://devtools/bundled/x.html',
      'view-source://https://a.b',
      'file://host/etc/passwd',
      'ostia://settings-schema',
      'ostia-preview://slot/index.html',
      'remote://folder/a.ts',
      'untitled://a',
      'app://index.html',
    ]) {
      expect(externalHref(url, { apps: true })).toBeNull()
      expect(linkKind(url)).toBeNull()
    }
  })

  it('treats chrome, edge and brave pages as app links that name their browser', () => {
    for (const [url, page] of [
      ['chrome://inspect/#remote-debugging', 'chrome'],
      ['edge://settings', 'edge'],
      ['brave://settings', 'brave'],
    ] as const) {
      expect(linkKind(url)).toBe('external')
      expect(externalHref(url, { apps: false })).toBeNull()
      expect(externalHref(url, { apps: true })).toBe(new URL(url).href)
      expect(browserPageOf(url)).toBe(page)
      expect(appLinkScheme(url)).toBe(page)
    }
    expect(browserPageOf('obsidian://open')).toBeNull()
    expect(browserPageOf('chrome:settings')).toBeNull()
  })

  it('names the scheme of an app link, never of a web or mail link', () => {
    expect(appLinkScheme('obsidian://open?vault=a')).toBe('obsidian')
    expect(appLinkScheme('https://a.b')).toBeNull()
    expect(appLinkScheme('mailto:a@b.c')).toBeNull()
    expect(appLinkScheme('javascript:alert(1)')).toBeNull()
  })

  it('refuses schemes that mount remote folders or reach Windows handlers', () => {
    for (const url of [
      'smb://host/share',
      'cifs://host/share',
      'afp://host/share',
      'nfs://host/export',
      'ftp://host/a',
      'ftps://host/a',
      'dav://host/a',
      'davs://host/a',
      'webdav://host/a',
      'search://query',
      'search-ms://query=a&crumb=location:\\\\h\\s',
      'ms-msdt://id',
      'ms-officecmd://x',
      'MS-Excel://ofe|u|http://h/a.xlsx',
    ]) {
      expect(externalHref(url, { apps: true })).toBeNull()
      expect(linkKind(url)).toBeNull()
    }
  })

  it('keeps everyday app schemes open', () => {
    for (const url of [
      'msteams://teams.microsoft.com/l/chat/0/0',
      'vnc://host:5900',
      'ssh://host:22',
      'tel://+886212345678',
      'facetime://+886212345678',
      'x-apple.systempreferences://com.apple.preference.security',
      'steam://run/440',
    ]) {
      expect(linkKind(url)).toBe('external')
      expect(externalHref(url, { apps: true })).not.toBeNull()
    }
  })

  it('refuses credentials in links of schemes outside the list', () => {
    for (const url of ['postgres://u:p@h/db', 'redis://:pw@h', 'ssh://me:pw@host']) {
      expect(externalHref(url, { apps: true })).toBeNull()
      expect(linkKind(url)).toBeNull()
    }
    expect(externalHref('https://u:p@example.com/', { apps: false })).toBe(
      'https://u:p@example.com/',
    )
    expect(externalHref('vscode://u:p@file/a', { apps: true })).toBe('vscode://u:p@file/a')
    expect(findAppLinks('db postgres://u:p@h/db or <redis://:pw@h>')).toEqual([])
  })

  it('opens links that carry only a user name', () => {
    for (const url of ['ssh://me@host', 'vnc://me@host:5900']) {
      expect(linkKind(url)).toBe('external')
      expect(externalHref(url, { apps: true })).toBe(url)
    }
    expect(findAppLinks('run ssh://me@host now').map((l) => l.url)).toEqual(['ssh://me@host'])
  })

  it('refuses a scheme that is too short or has no double slash', () => {
    for (const url of ['a://b', 'x-custom:do', 'foo::bar', 'C://Windows']) {
      expect(externalHref(url, { apps: true })).toBeNull()
      expect(linkKind(url)).toBeNull()
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
    expect(linkKind('slack://channel?id=1')).toBe('external')
  })

  it('refuses everything else', () => {
    expect(linkKind('javascript:alert(1)')).toBeNull()
    expect(linkKind('file:///etc/passwd')).toBeNull()
    expect(linkKind('x-custom:do')).toBeNull()
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

  it('ignores web, file, blocked and empty links, and schemes inside a word', () => {
    expect(
      findAppLinks(
        'https://a.b/zed://x file:///tmp/a javascript://x ostia-preview://s obsidian:// _zed://x',
      ),
    ).toEqual([])
  })

  it('finds plain and bracketed links of any scheme', () => {
    const text = 'go slack://channel?id=1, then <zed://file/My Dir/a.ts> or (x-app+v1.2://do).'
    expect(findAppLinks(text).map((l) => l.url)).toEqual([
      'slack://channel?id=1',
      'zed://file/My Dir/a.ts',
      'x-app+v1.2://do',
    ])
  })

  it('does not link short schemes, code without a double slash or text after Chinese punctuation', () => {
    expect(findAppLinks('a://b std::vector foo::bar://x C://Win')).toEqual([])
    expect(findAppLinks('開 zed://file/a，然後（slack://x）').map((l) => l.url)).toEqual([
      'zed://file/a',
      'slack://x',
    ])
  })

  it('scans a long run of scheme characters in linear time', () => {
    const started = performance.now()
    expect(findAppLinks(`${'a+'.repeat(50_000)}:/ ${'ab'.repeat(50_000)}`)).toEqual([])
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 60_000)
})
