import { describe, expect, it } from 'vitest'
import { FILES_LIMIT_DEFAULT, parseFilesArgs, parseFindArgs } from './args'

describe('parseFindArgs', () => {
  it('reads the text and the switches', () => {
    expect(parseFindArgs(['--regex', '-s', '--word', 'foo.*bar', '--json'])).toEqual({
      query: {
        text: 'foo.*bar',
        regex: true,
        caseSensitive: true,
        wholeWord: true,
        include: [],
        exclude: [],
      },
      json: true,
    })
  })

  it('sorts globs into include and, with a leading !, exclude', () => {
    const parsed = parseFindArgs(['-g', 'src/**', '--glob', '!dist/**', 'x'])
    expect(parsed).toMatchObject({ query: { include: ['src/**'], exclude: ['dist/**'] } })
  })

  it('takes everything after -- as the text, even when it looks like an option', () => {
    expect(parseFindArgs(['--', '--regex', 'two'])).toMatchObject({
      query: { text: '--regex two', regex: false },
    })
  })

  it('refuses an unknown option, a glob without a pattern and an empty text', () => {
    expect(parseFindArgs(['--pre', 'sh', 'x'])).toBe('unknown option --pre')
    expect(parseFindArgs(['x', '--glob'])).toBe('--glob needs a pattern')
    expect(parseFindArgs(['--json'])).toBe('name the text to find')
  })
})

describe('parseFilesArgs', () => {
  it('reads the name, a limit and --json', () => {
    expect(parseFilesArgs(['edi', '--limit', '5', '--json'])).toEqual({
      query: 'edi',
      limit: 5,
      json: true,
    })
    expect(parseFilesArgs(['edi'])).toMatchObject({ limit: FILES_LIMIT_DEFAULT })
  })

  it('refuses a bad limit and an empty name', () => {
    expect(parseFilesArgs(['x', '--limit', '0'])).toMatch(/--limit/)
    expect(parseFilesArgs(['x', '--limit', 'many'])).toMatch(/--limit/)
    expect(parseFilesArgs([])).toBe('name part of the file name to find')
  })
})
