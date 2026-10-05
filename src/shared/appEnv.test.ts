import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { dualEnv, isAppEnvName, readEnv, shellEnv, withoutEnv } from './appEnv'

describe('readEnv', () => {
  it('prefers the OSTIA_ name when both are set', () => {
    expect(readEnv('SOCKET', { OSTIA_SOCKET: '/new', PINE_SOCKET: '/old' })).toBe('/new')
  })

  it('still works when only the old PINE_ name is set', () => {
    expect(readEnv('SOCKET', { PINE_SOCKET: '/old' })).toBe('/old')
  })

  it('treats an empty value as unset and falls back', () => {
    expect(readEnv('SOCKET', { OSTIA_SOCKET: '', PINE_SOCKET: '/old' })).toBe('/old')
    expect(readEnv('SOCKET', { OSTIA_SOCKET: '', PINE_SOCKET: '' })).toBeUndefined()
    expect(readEnv('SOCKET', {})).toBeUndefined()
  })
})

describe('dualEnv', () => {
  it('sets every variable under both names with the same value', () => {
    expect(dualEnv({ SOCKET: '/s', TOKEN: 't' })).toEqual({
      OSTIA_SOCKET: '/s',
      PINE_SOCKET: '/s',
      OSTIA_TOKEN: 't',
      PINE_TOKEN: 't',
    })
  })
})

describe('withoutEnv', () => {
  it('drops both names of each variable and keeps the rest', () => {
    const env = { OSTIA_PANE_ID: 'p', PINE_PANE_ID: 'p', PINE_SOCKET: '/s', PATH: '/bin' }
    expect(withoutEnv(env, ['PANE_ID'])).toEqual({ PINE_SOCKET: '/s', PATH: '/bin' })
  })
})

describe('isAppEnvName', () => {
  it('matches both prefixes only', () => {
    expect(isAppEnvName('OSTIA_TOKEN')).toBe(true)
    expect(isAppEnvName('PINE_TOKEN')).toBe(true)
    expect(isAppEnvName('NOT_PINE_TOKEN')).toBe(false)
  })
})

describe('shellEnv', () => {
  const expand = (env: Record<string, string>): string =>
    execFileSync('/bin/sh', ['-c', `printf '%s' "${shellEnv('CLI')}"`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    })

  it('expands to OSTIA_ first, then PINE_, in a POSIX shell', () => {
    expect(expand({ OSTIA_CLI: '/new', PINE_CLI: '/old' })).toBe('/new')
    expect(expand({ PINE_CLI: '/old' })).toBe('/old')
    expect(expand({})).toBe('')
  })
})
