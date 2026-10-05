import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { appEnv, isAppEnvName, readEnv, shellEnv, withoutEnv } from './appEnv'

describe('readEnv', () => {
  it('reads the OSTIA_ name and never a PINE_ one', () => {
    expect(readEnv('SOCKET', { OSTIA_SOCKET: '/new', PINE_SOCKET: '/old' })).toBe('/new')
    expect(readEnv('SOCKET', { PINE_SOCKET: '/old' })).toBeUndefined()
  })

  it('treats an empty value as unset', () => {
    expect(readEnv('SOCKET', { OSTIA_SOCKET: '' })).toBeUndefined()
    expect(readEnv('SOCKET', {})).toBeUndefined()
  })
})

describe('appEnv', () => {
  it('sets every variable under its OSTIA_ name only', () => {
    expect(appEnv({ SOCKET: '/s', TOKEN: 't' })).toEqual({ OSTIA_SOCKET: '/s', OSTIA_TOKEN: 't' })
  })
})

describe('withoutEnv', () => {
  it('drops the named variables and keeps the rest', () => {
    const env = { OSTIA_PANE_ID: 'p', OSTIA_SOCKET: '/s', PATH: '/bin' }
    expect(withoutEnv(env, ['PANE_ID'])).toEqual({ OSTIA_SOCKET: '/s', PATH: '/bin' })
  })
})

describe('isAppEnvName', () => {
  it('matches the OSTIA_ prefix only', () => {
    expect(isAppEnvName('OSTIA_TOKEN')).toBe(true)
    expect(isAppEnvName('PINE_TOKEN')).toBe(false)
    expect(isAppEnvName('NOT_OSTIA_TOKEN')).toBe(false)
  })
})

describe('shellEnv', () => {
  const expand = (env: Record<string, string>): string =>
    execFileSync('/bin/sh', ['-c', `printf '%s' "${shellEnv('CLI')}"`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    })

  it('expands the OSTIA_ variable in a POSIX shell and ignores a PINE_ one', () => {
    expect(expand({ OSTIA_CLI: '/new' })).toBe('/new')
    expect(expand({ PINE_CLI: '/old' })).toBe('')
  })
})
