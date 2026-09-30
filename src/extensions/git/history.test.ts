import { describe, expect, it } from 'vitest'
import {
  FIELD_SEP,
  RECORD_SEP,
  isUncommitted,
  parseBlamePorcelain,
  parseLog,
  parseNameStatus,
} from './history'

const SHA1 = '96756f7f86aa09fd43994e6c7ea5b835674f9eb3'
const SHA2 = '1b0124329a747e3e811541c2010dfd25241f4c6d'
const ZERO = '0'.repeat(40)

const record = (...fields: string[]): string => `${fields.join(FIELD_SEP)}${RECORD_SEP}\n`

describe('parseLog', () => {
  it('reads sha, author, email, time and subject from each record', () => {
    const out =
      record(SHA1, 'Ann Lee', 't@e.com', '1700003600', 'second') +
      record(SHA2, 'Ann Lee', 't@e.com', '1700000000', 'first line')
    expect(parseLog(out)).toEqual([
      { sha: SHA1, author: 'Ann Lee', email: 't@e.com', time: 1700003600, subject: 'second' },
      { sha: SHA2, author: 'Ann Lee', email: 't@e.com', time: 1700000000, subject: 'first line' },
    ])
  })

  it('keeps separators-free subjects intact and skips malformed records', () => {
    const out = `${record(SHA1, 'A', 'a@x', '1', 'fix: a | b')}garbage${RECORD_SEP}`
    expect(parseLog(out).map((c) => c.subject)).toEqual(['fix: a | b'])
  })
})

describe('parseNameStatus', () => {
  it('reads added, deleted and renamed files from -z output', () => {
    expect(parseNameStatus('A\0a.txt\0')).toEqual([{ path: 'a.txt', code: 'A' }])
    expect(parseNameStatus('D\0a.txt\0A\0b.txt\0R087\0old name.txt\0new name.txt\0')).toEqual([
      { path: 'a.txt', code: 'D' },
      { path: 'b.txt', code: 'A' },
      { path: 'new name.txt', origPath: 'old name.txt', code: 'R' },
    ])
  })
})

describe('parseBlamePorcelain', () => {
  const porcelain = [
    `${SHA1} 1 1 3`,
    'author Ann Lee',
    'author-mail <t@e.com>',
    'author-time 1700003600',
    'author-tz -0500',
    'committer Ann Lee',
    'summary second',
    'filename b.txt',
    '\tone',
    `${SHA1} 2 2`,
    '\tTWO',
    `${SHA1} 3 3`,
    '\t\tthree',
    `${ZERO} 4 4 1`,
    'author Not Committed Yet',
    'author-time 1790782170',
    'summary Version of b.txt from b.txt',
    `previous ${SHA1} b.txt`,
    'filename b.txt',
    '\tfour',
    '',
  ].join('\n')

  it('gives every line its commit, reusing headers a commit printed once', () => {
    const lines = parseBlamePorcelain(porcelain)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toEqual({
      line: 1,
      sha: SHA1,
      author: 'Ann Lee',
      time: 1700003600,
      summary: 'second',
      text: 'one',
    })
    expect(lines[1]).toMatchObject({ line: 2, sha: SHA1, author: 'Ann Lee', text: 'TWO' })
    expect(lines[2].text).toBe('\tthree')
    expect(lines[3]).toMatchObject({ line: 4, sha: ZERO, text: 'four' })
  })

  it('recognizes lines that are not committed yet', () => {
    expect(isUncommitted(ZERO)).toBe(true)
    expect(isUncommitted(SHA1)).toBe(false)
  })
})
