import { describe, expect, it } from 'vitest'
import { asksPresence, parseTokenArgs, shownUsage } from './token'

describe('parseTokenArgs', () => {
  it('creates a token with a name and one or more capabilities', () => {
    expect(
      parseTokenArgs(['create', 'cron', '--cap', 'read-board', '--cap', 'type-other-pane']),
    ).toEqual({
      method: 'token.create',
      params: { name: 'cron', caps: ['read-board', 'type-other-pane'] },
    })
  })

  it('passes the scope, the expiry and the workspaces the token creates', () => {
    expect(
      parseTokenArgs([
        'create',
        'ceo',
        '--cap',
        'read-board',
        '--scope',
        'group:AurigaX',
        '--scope',
        'workspace:ws-1',
        '--scope',
        'group:Work: Ops',
        '--own-workspaces',
        '--expires',
        '30d',
      ]),
    ).toEqual({
      method: 'token.create',
      params: {
        name: 'ceo',
        caps: ['read-board'],
        scope: {
          kind: 'limited',
          groups: ['AurigaX', 'Work: Ops'],
          workspaces: ['ws-1'],
          ownWorkspaces: true,
        },
        expires: '30d',
      },
    })
    expect(parseTokenArgs(['create', 'a', '--cap', 'notify', '--scope', 'all']).params).toEqual({
      name: 'a',
      caps: ['notify'],
      scope: { kind: 'all' },
    })
  })

  it('expands a preset and adds the extra capabilities', () => {
    expect(
      parseTokenArgs(['create', 'm', '--preset', 'readonly', '--cap', 'notify', '--scope', 'all'])
        .params,
    ).toMatchObject({ caps: ['read-board', 'read-other-pane', 'notify'] })
    expect(
      parseTokenArgs(['create', 'c', '--preset', 'coordinator', '--scope', 'all']).params,
    ).toMatchObject({
      caps: [
        'read-board',
        'read-other-pane',
        'send-other-pane',
        'type-other-pane',
        'process',
        'notify',
      ],
    })
    expect(() => parseTokenArgs(['create', 'x', '--preset', 'admin'])).toThrow('--preset admin')
  })

  it('needs a confirmation for a token that never expires', () => {
    expect(() =>
      parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'all', '--expires', 'never']),
    ).toThrow('--yes-never-expires')
    expect(
      parseTokenArgs([
        'create',
        'x',
        '--cap',
        'notify',
        '--scope',
        'all',
        '--expires',
        'never',
        '--yes-never-expires',
      ]).params,
    ).toMatchObject({ expires: 'never', confirmNeverExpires: true })
  })

  it('refuses a scope it cannot read', () => {
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'team:a'])).toThrow(
      '--scope team:a',
    )
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'group:'])).toThrow(
      '--scope group:',
    )
    expect(() =>
      parseTokenArgs(['create', 'x', '--cap', 'notify', '--scope', 'all', '--scope', 'group:a']),
    ).toThrow('--scope all stands alone')
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--own-workspaces'])).toThrow(
      '--own-workspaces needs',
    )
  })

  it('updates the name alone, or the settings that regenerate the token', () => {
    expect(parseTokenArgs(['update', 'ceo', '--name', 'ostia-ceo'])).toEqual({
      method: 'token.update',
      params: { id: 'ceo', name: 'ostia-ceo' },
    })
    expect(parseTokenArgs(['update', 'ceo', '--cap', 'notify', '--expires', '1y'])).toEqual({
      method: 'token.update',
      params: { id: 'ceo', caps: ['notify'], expires: '1y' },
    })
    expect(parseTokenArgs(['update', 'ceo', '--cap', 'notify', '--yes-never-expires'])).toEqual({
      method: 'token.update',
      params: { id: 'ceo', caps: ['notify'], confirmNeverExpires: true },
    })
    expect(() => parseTokenArgs(['update', 'ceo', '--yes-never-expires'])).toThrow(
      'usage: ostia token',
    )
    expect(() => parseTokenArgs(['update', 'ceo'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['update', '--name', 'x'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['create', 'x', '--cap', 'notify', '--name', 'y'])).toThrow(
      'usage: ostia token',
    )
  })

  it('lists, shows and revokes', () => {
    expect(parseTokenArgs(['list', '--json'])).toEqual({
      method: 'token.list',
      params: {},
      json: true,
    })
    expect(parseTokenArgs(['show', 'ceo', '--json'])).toEqual({
      method: 'token.usage',
      params: { id: 'ceo' },
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
    expect(() => parseTokenArgs(['show'])).toThrow('usage: ostia token')
    expect(() => parseTokenArgs(['rotate', 'x'])).toThrow('usage: ostia token')
  })
})

describe('asksPresence', () => {
  it('warns that creating or regenerating a token asks the human twice, and renaming does not', () => {
    expect(
      asksPresence(parseTokenArgs(['create', 'ceo', '--preset', 'readonly', '--scope', 'all'])),
    ).toBe(true)
    expect(asksPresence(parseTokenArgs(['update', 'ceo', '--expires', '7d']))).toBe(true)
    expect(asksPresence(parseTokenArgs(['update', 'ceo', '--cap', 'notify']))).toBe(true)
    expect(asksPresence(parseTokenArgs(['update', 'ceo', '--scope', 'all']))).toBe(true)
    expect(asksPresence(parseTokenArgs(['update', 'ceo', '--name', 'boss']))).toBe(false)
    expect(asksPresence(parseTokenArgs(['revoke', 'ceo']))).toBe(false)
    expect(asksPresence(parseTokenArgs(['list']))).toBe(false)
  })
})

describe('shownUsage', () => {
  const token = {
    id: 'script_1',
    name: 'ceo',
    caps: ['read-board'],
    scope: { kind: 'all' as const },
    createdAt: '2026-10-10T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: '2026-10-11T06:02:11.000Z',
  }

  it('prints the connections, the last 24 hours and the recent calls with names', () => {
    const lines = shownUsage(token, {
      calls: [
        {
          at: '2026-10-11T06:02:11.000Z',
          method: 'pane.read',
          target: { workspaceId: 'w1', paneId: 'p1' },
          outcome: 'out-of-scope',
          code: 'needs-elevation: all-workspaces',
        },
        { at: '2026-10-11T06:01:00.000Z', method: '', target: {}, outcome: 'regenerated' },
        { at: '2026-10-11T06:00:00.000Z', method: 'notify', target: {}, outcome: 'ok' },
      ],
      connections: [{ pid: 48211, program: 'zsh' }],
      last24h: { calls: 142, refused: 2 },
      names: { workspaces: { w1: 'homelab' }, panes: {} },
    })
    expect(lines).toContain('connected  1 from zsh (pid 48211)')
    expect(lines).toContain('last 24h   142 calls, 2 refused')
    expect(lines.slice(-4)).toEqual([
      'TIME  ACTION  TARGET  RESULT',
      '2026-10-11T06:02:11.000Z  pane.read  homelab / p1  out-of-scope (needs-elevation: all-workspaces)',
      '2026-10-11T06:01:00.000Z  regenerated',
      '2026-10-11T06:00:00.000Z  notify  -  ok',
    ])
  })

  it('says when nothing was called', () => {
    const lines = shownUsage(token, {
      calls: [],
      connections: [],
      last24h: { calls: 0, refused: 0 },
      names: { workspaces: {}, panes: {} },
    })
    expect(lines).toContain('connected  0')
    expect(lines.at(-1)).toBe('no calls recorded')
  })
})
