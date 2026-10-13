import { describe, expect, it } from 'vitest'
import {
  PREVIEW_CHARS,
  filesArgv,
  parseMatch,
  preview,
  relativePath,
  ripgrepPath,
  textArgv,
} from './ripgrep'

const query = {
  text: 'hello',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  includeIgnored: false,
}

function matchEvent(path: string, text: string, line: number, spans: [number, number][]): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: spans.map(([start, end]) => ({ match: { text: '' }, start, end })),
    },
  })
}

describe('textArgv', () => {
  it('searches literally and ignoring case by default, after an end-of-options marker', () => {
    const argv = textArgv(query)
    expect(argv).toContain('--fixed-strings')
    expect(argv).toContain('--ignore-case')
    expect(argv).toContain('--no-config')
    expect(argv.slice(-3)).toEqual(['--', 'hello', '.'])
  })

  it('passes a text that looks like an option as data', () => {
    expect(textArgv({ ...query, text: '--pre=sh' }).slice(-3)).toEqual(['--', '--pre=sh', '.'])
  })

  it('maps regex, case and whole word to rg flags', () => {
    const argv = textArgv({ ...query, regex: true, caseSensitive: true, wholeWord: true })
    expect(argv).not.toContain('--fixed-strings')
    expect(argv).toContain('--case-sensitive')
    expect(argv).toContain('--word-regexp')
  })

  it('leaves PDFs to the PDF search, whatever their case', () => {
    expect(textArgv(query).join(' ')).toContain('--iglob !*.pdf')
    expect(filesArgv(false).join(' ')).not.toContain('*.pdf')
  })

  it('respects .gitignore unless ignored files are included', () => {
    expect(textArgv(query)).not.toContain('--no-ignore')
    expect(filesArgv(false)).not.toContain('--no-ignore')
    expect(textArgv({ ...query, includeIgnored: true })).toContain('--no-ignore')
    expect(filesArgv(true)).toContain('--no-ignore')
  })

  it('always skips the .git folder, for text and for file lists', () => {
    expect(textArgv(query).join(' ')).toContain('--glob !.git')
    expect(filesArgv(false).join(' ')).toContain('--glob !.git')
  })
})

describe('parseMatch', () => {
  it('reads path, line, a 1-based column and the matched range', () => {
    const hit = parseMatch(matchEvent('./src/a.ts', 'const hello = 1\n', 12, [[6, 11]]))
    expect(hit).toEqual({
      path: 'src/a.ts',
      match: { line: 12, column: 7, text: 'const hello = 1', ranges: [[6, 11]] },
    })
  })

  it('turns byte offsets into character offsets on non-ASCII lines', () => {
    const hit = parseMatch(matchEvent('./a.txt', 'café hello\n', 2, [[6, 11]]))
    expect(hit?.match.column).toBe(6)
    expect(hit?.match.ranges).toEqual([[5, 10]])
    expect(hit?.match.text.slice(5, 10)).toBe('hello')
  })

  it('ignores events that are not matches and lines that are not JSON', () => {
    expect(parseMatch(JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }))).toBeNull()
    expect(parseMatch('rg: warning')).toBeNull()
  })

  it('skips a line rg could only give as bytes', () => {
    const raw = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a' }, lines: { bytes: 'AAE=' }, line_number: 1, submatches: [] },
    })
    expect(parseMatch(raw)).toBeNull()
  })
})

describe('preview', () => {
  it('drops the indent before the match', () => {
    expect(preview('      return hello', [[13, 18]])).toEqual({
      text: 'return hello',
      ranges: [[7, 12]],
    })
  })

  it('clips a long line around the first match and keeps the range on the match', () => {
    const line = `${'x'.repeat(5000)}needle${'y'.repeat(5000)}`
    const shown = preview(line, [[5000, 5006]])
    expect(shown.text.length).toBe(PREVIEW_CHARS)
    const [[from, to]] = shown.ranges
    expect(shown.text.slice(from, to)).toBe('needle')
  })

  it('drops ranges past the clipped text', () => {
    const line = `a${'x'.repeat(1000)}a`
    expect(
      preview(line, [
        [0, 1],
        [1001, 1002],
      ]).ranges,
    ).toEqual([[0, 1]])
  })
})

describe('relativePath', () => {
  it('strips the ./ rg prints for the searched folder', () => {
    expect(relativePath('./src/a.ts')).toBe('src/a.ts')
    expect(relativePath('.env')).toBe('.env')
  })
})

describe('ripgrepPath', () => {
  it('points at the platform package next to the app', () => {
    expect(ripgrepPath('/repo', 'linux', 'x64')).toBe(
      '/repo/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
    )
  })

  it('points into app.asar.unpacked for a packaged app', () => {
    expect(ripgrepPath('/opt/ostia/resources/app.asar', 'darwin', 'arm64')).toBe(
      '/opt/ostia/resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
    )
  })
})
