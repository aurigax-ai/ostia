import { describe, expect, it } from 'vitest'
import { fileUrlOpener, fileUrlPath, findFileUrls, opensFileUrl } from './fileUrls'

describe('fileUrlPath', () => {
  it('decodes percent-encoded spaces and CJK into an absolute path', () => {
    expect(fileUrlPath('file:///Users/j/%E6%9C%83%E8%AD%B0%20%E8%A8%98%E9%8C%84.pdf')).toBe(
      '/Users/j/會議 記錄.pdf',
    )
    expect(fileUrlPath('file:///Users/j/會議記錄.html')).toBe('/Users/j/會議記錄.html')
  })

  it('accepts an empty host or localhost and refuses any other host', () => {
    expect(fileUrlPath('file://localhost/Users/j/a.pdf')).toBe('/Users/j/a.pdf')
    expect(fileUrlPath('file:///Users/j/a.pdf')).toBe('/Users/j/a.pdf')
    expect(fileUrlPath('file://server/Users/j/a.pdf')).toBeNull()
    expect(fileUrlPath('file://192.168.1.2/a.pdf')).toBeNull()
  })

  it('resolves .. including encoded slashes, and drops the query and fragment', () => {
    expect(fileUrlPath('file:///Users/j/../../etc/hosts')).toBe('/etc/hosts')
    expect(fileUrlPath('file:///Users/j/a/..%2F..%2F..%2Fetc/hosts')).toBe('/etc/hosts')
    expect(fileUrlPath('file:///Users/j/a.html?x=1#top')).toBe('/Users/j/a.html')
  })

  it('refuses other schemes, bad escapes and NUL', () => {
    expect(fileUrlPath('https://a.b/a.pdf')).toBeNull()
    expect(fileUrlPath('/Users/j/a.pdf')).toBeNull()
    expect(fileUrlPath('file:///Users/j/%E0%A4%A.pdf')).toBeNull()
    expect(fileUrlPath('file:///Users/j/a%00.pdf')).toBeNull()
    expect(fileUrlPath('not a url')).toBeNull()
  })
})

describe('fileUrlOpener', () => {
  it('opens html in a page and the allowlist in the default app, in any case', () => {
    expect(fileUrlOpener('/a/speakers.html')).toBe('html-page')
    expect(fileUrlOpener('/a/B.HTM')).toBe('html-page')
    for (const ext of [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg',
      'drawio',
      'md',
      'txt',
      'csv',
      'json',
      'docx',
      'xlsx',
      'pptx',
    ]) {
      expect(fileUrlOpener(`/a/file.${ext}`)).toBe('default-app')
      expect(fileUrlOpener(`/a/file.${ext.toUpperCase()}`)).toBe('default-app')
    }
  })

  it('keeps programs, installers, scripts and names without an extension inert', () => {
    for (const name of [
      'Tool.app',
      'run.command',
      'build.sh',
      'x.tool',
      'x.terminal',
      'x.pkg',
      'x.dmg',
      'x.workflow',
      'x.scpt',
      'x.jar',
      'tool',
      '.json',
      'a.pdf.sh',
      'docs.pdf/',
    ]) {
      expect(fileUrlOpener(`/a/${name}`)).toBeNull()
    }
  })
})

describe('findFileUrls', () => {
  it('finds allowlisted file urls in text and trims trailing punctuation', () => {
    const text =
      'see file:///Users/j/.cache/r/speakers.html, and <file:///Users/j/a%20b.pdf> or (file:///Users/j/x.png).'
    expect(findFileUrls(text).map((m) => m.url)).toEqual([
      'file:///Users/j/.cache/r/speakers.html',
      'file:///Users/j/a%20b.pdf',
      'file:///Users/j/x.png',
    ])
    const [first] = findFileUrls(text)
    expect(text.slice(first.start, first.end)).toBe(first.url)
  })

  it('skips file urls that would stay inert', () => {
    expect(
      findFileUrls('file:///Users/j/run.command file:///Users/j/Tool.app file:///Users/j/docs/'),
    ).toEqual([])
    expect(findFileUrls('file://server/Users/j/a.pdf https://a.b/a.pdf')).toEqual([])
  })

  it('tells which urls are worth asking about', () => {
    expect(opensFileUrl('file:///Users/j/a.pdf')).toBe(true)
    expect(opensFileUrl('file:///Users/j/a.sh')).toBe(false)
    expect(opensFileUrl('https://a.b/a.pdf')).toBe(false)
  })
})
