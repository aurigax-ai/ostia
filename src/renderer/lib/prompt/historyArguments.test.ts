import { describe, expect, it } from 'vitest'
import { historyArguments } from './historyArguments'
import { historyFacts } from './historyRank'

const facts = (...commands: string[]) =>
  historyFacts(
    commands.map((command) => ({ command, time: null })),
    [],
  )

describe('historyArguments', () => {
  it('lists what followed the same command words, newest first and once each', () => {
    const entries = facts(
      'git checkout main',
      'git checkout feature/login',
      'git status',
      'git checkout main',
      'ssh build-box',
    )
    expect(historyArguments('git checkout ', entries)).toEqual(['main', 'feature/login'])
    expect(historyArguments('ssh ', entries)).toEqual(['build-box'])
    expect(historyArguments('git ', entries)).toEqual(['checkout', 'status'])
  })

  it('reads the command of the last part of a chained line and skips options', () => {
    const entries = facts('cd app && git checkout fix/a', 'git checkout -b new', "cd 'My Docs'")
    expect(historyArguments('git checkout ', entries)).toEqual(['fix/a'])
    expect(historyArguments('ls; cd ', entries)).toEqual(['My Docs'])
  })

  it('stops at the cap and has nothing before a command is typed', () => {
    const entries = facts(...Array.from({ length: 30 }, (_, i) => `ssh host${i}`))
    expect(historyArguments('ssh ', entries)).toHaveLength(8)
    expect(historyArguments('', entries)).toEqual([])
  })
})
