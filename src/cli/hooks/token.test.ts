import { describe, expect, it } from 'vitest'
import { parseTokenArgs } from './token'

describe('parseTokenArgs', () => {
  it('creates a token with a name and one or more capabilities', () => {
    expect(
      parseTokenArgs(['create', 'cron', '--cap', 'read-board', '--cap', 'type-other-pane']),
    ).toEqual({
      method: 'token.create',
      params: { name: 'cron', caps: ['read-board', 'type-other-pane'] },
    })
  })

  it('lists and revokes', () => {
    expect(parseTokenArgs(['list', '--json'])).toEqual({
      method: 'token.list',
      params: {},
      json: true,
    })
    expect(parseTokenArgs(['revoke', 'script_1'])).toEqual({
      method: 'token.revoke',
      params: { id: 'script_1' },
    })
  })

  it('refuses a token without capabilities, a missing id and unknown subcommands', () => {
    expect(() => parseTokenArgs(['create', 'cron'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['create', '--cap', 'read-board'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['revoke'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['rotate', 'x'])).toThrow('usage: ostia token')
  })
})
