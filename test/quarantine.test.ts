import { describe, expect, it } from 'vitest'
import {
  ROOT,
  isListed,
  loadQuarantine,
  playwrightPattern,
  quarantineProblems,
} from './quarantine.mjs'

const today = new Date().toISOString().slice(0, 10)

function daysFrom(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

const valid = {
  file: 'src/main/notifyCommand.test.ts',
  name: 'runNotifyCommand > runs the program directly with the expanded argv, so shell metacharacters stay data',
  issue: 122,
  until: '2026-10-20',
}

const issueStates = { 63: 'open', 122: 'open', 124: 'closed' }

describe('test/quarantine.json', () => {
  it('lists only live tests with a date no more than 30 days out', () => {
    expect(quarantineProblems(loadQuarantine(), { today })).toEqual([])
  })
})

describe('quarantineProblems', () => {
  it('accepts an entry naming a test in its file, before its date', () => {
    expect(quarantineProblems([valid], { today: '2026-10-06', issueStates })).toEqual([])
  })

  it('fails an entry whose date has passed', () => {
    expect(quarantineProblems([valid], { today: '2026-10-21', issueStates })).toEqual([
      expect.stringContaining('expired on 2026-10-20'),
    ])
  })

  it('fails an entry dated more than 30 days out', () => {
    const entry = { ...valid, until: daysFrom('2026-10-06', 31) }
    expect(quarantineProblems([entry], { today: '2026-10-06' })).toEqual([
      expect.stringContaining('more than 30 days out'),
    ])
  })

  it('fails an entry whose issue is closed', () => {
    const entry = { ...valid, issue: 124 }
    expect(quarantineProblems([entry], { today: '2026-10-06', issueStates })).toEqual([
      expect.stringContaining('issue #124 is closed'),
    ])
  })

  it('fails an entry naming a file that does not exist', () => {
    const entry = { ...valid, file: 'src/main/gone.test.ts' }
    expect(quarantineProblems([entry], { today: '2026-10-06' })).toEqual([
      expect.stringContaining('no such file'),
    ])
  })

  it('fails an entry naming a test its file does not have', () => {
    const entry = { ...valid, name: 'runNotifyCommand > a test nobody wrote' }
    expect(quarantineProblems([entry], { today: '2026-10-06' })).toEqual([
      expect.stringContaining('no test titled "a test nobody wrote"'),
    ])
  })

  it('fails an entry without an issue, with an unknown platform or listed twice', () => {
    const problems = quarantineProblems(
      [
        { ...valid, issue: undefined },
        { ...valid, platforms: ['win32'] },
      ],
      { today: '2026-10-06' },
    )
    expect(problems).toEqual([
      expect.stringContaining('needs an issue number'),
      expect.stringContaining('listed twice'),
      expect.stringContaining('platforms must list some of linux, darwin'),
    ])
  })
})

describe('isListed', () => {
  it('matches an absolute test file path and the full title', () => {
    expect(isListed([valid], `${ROOT}/${valid.file}`, valid.name)).toBe(true)
    expect(isListed([valid], `${ROOT}/${valid.file}`, 'runNotifyCommand > other')).toBe(false)
  })
})

describe('playwrightPattern', () => {
  it("matches Playwright's grep title of exactly that test", () => {
    const pattern = playwrightPattern({ ...valid, file: 'e2e/a.spec.ts', name: 'group > does (x)' })
    expect(pattern.test('  a.spec.ts group does (x)')).toBe(true)
    expect(pattern.test('  b.spec.ts group does (x)')).toBe(false)
    expect(pattern.test('  a.spec.ts group does (x) too')).toBe(false)
  })
})
