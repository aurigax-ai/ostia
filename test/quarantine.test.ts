import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROOT,
  dueForReminder,
  isListed,
  loadQuarantine,
  playwrightPattern,
  quarantineProblems,
  reminderBody,
  reminderMarker,
  unreminded,
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
    expect(quarantineProblems(loadQuarantine(), { today, enforceExpiry: false })).toEqual([])
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

  it('leaves the date and the issue state to main and nightly when expiry is not enforced', () => {
    const closed = { ...valid, issue: 124 }
    expect(
      quarantineProblems([valid, closed], {
        today: '2026-10-21',
        issueStates,
        enforceExpiry: false,
      }),
    ).toEqual([expect.stringContaining('listed twice')])
  })

  it('passes an entry on its last day and fails it the day after', () => {
    const entry = { ...valid, until: '2026-11-05' }
    expect(quarantineProblems([entry], { today: '2026-10-08', issueStates })).toEqual([])
    expect(quarantineProblems([entry], { today: '2026-11-05', issueStates })).toEqual([])
    expect(quarantineProblems([entry], { today: '2026-11-06', issueStates })).toEqual([
      expect.stringContaining('expired on 2026-11-05'),
    ])
    expect(
      quarantineProblems([entry], { today: '2026-11-06', issueStates, enforceExpiry: false }),
    ).toEqual([])
  })

  it('still fails a date more than 30 days out when expiry is not enforced', () => {
    const entry = { ...valid, until: daysFrom('2026-10-08', 31) }
    expect(quarantineProblems([entry], { today: '2026-10-08', enforceExpiry: false })).toEqual([
      expect.stringContaining('more than 30 days out'),
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

describe('reminders', () => {
  const entry = { ...valid, until: '2026-11-05' }
  const other = { ...valid, name: 'runNotifyCommand > other', until: '2026-11-20' }

  it('are due from 7 days before the date, including after it', () => {
    expect(dueForReminder([entry, other], '2026-10-08')).toEqual([])
    expect(dueForReminder([entry, other], '2026-10-28')).toEqual([])
    expect(dueForReminder([entry, other], '2026-10-29')).toEqual([entry])
    expect(dueForReminder([entry, other], '2026-11-06')).toEqual([entry])
  })

  it('are posted once per entry and date', () => {
    const body = reminderBody([entry], '2026-10-29')
    expect(body).toContain(reminderMarker(entry))
    expect(body).toContain('expires on 2026-11-05')
    expect(unreminded([entry], ['unrelated', body])).toEqual([])
    expect(unreminded([{ ...entry, until: '2026-11-12' }], [body])).toHaveLength(1)
    expect(unreminded([entry, other], [body])).toEqual([other])
  })

  it('say when an entry has already expired', () => {
    expect(reminderBody([entry], '2026-11-06')).toContain('expired on 2026-11-05')
    expect(reminderBody([entry], '2026-11-05')).toContain('expires today')
  })
})

describe('scripts/quarantine.mjs --today', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/quarantine.mjs'), ...args], {
      encoding: 'utf8',
    })

  it.each(['2026-13-40', '2026-02-30', 'tomorrow', '2026-1-1'])(
    'rejects %s with usage',
    (value) => {
      for (const command of ['issues', 'remind']) {
        const result = run(command, `--today=${value}`)
        expect(result.status).toBe(2)
        expect(result.stderr).toContain('usage:')
      }
    },
  )
})
