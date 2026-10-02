import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSENT_HOSTS_MAX, HelperConsent, parseConsent } from './consent'

const made: string[] = []

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pine-ssh-consent-'))
  made.push(dir)
  return join(dir, 'data', 'helper-hosts.json')
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseConsent', () => {
  it('SSH-C54 keeps only valid answers and never throws on a damaged file', () => {
    expect(parseConsent('not json').size).toBe(0)
    expect(parseConsent('[]').size).toBe(0)
    expect(parseConsent('{"hosts": []}').size).toBe(0)
    const hosts = parseConsent(
      JSON.stringify({
        hosts: {
          'dev@db:2200': { answer: 'allowed', version: '0123456789ab', at: '2026-10-02' },
          web: { answer: 'refused', at: 5 },
          maybe: { answer: 'perhaps' },
          'bad host': { answer: 'allowed' },
          odd: { answer: 'allowed', version: '../../x' },
          none: null,
        },
      }),
    )
    expect([...hosts.entries()]).toEqual([
      ['dev@db:2200', { answer: 'allowed', version: '0123456789ab', at: '2026-10-02' }],
      ['web', { answer: 'refused', at: '' }],
      ['odd', { answer: 'allowed', at: '' }],
    ])
  })

  it('SSH-C54 stops at the host limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`h${i}`, { answer: 'refused', at: '' }]),
    )
    expect(parseConsent(JSON.stringify({ hosts: many })).size).toBe(CONSENT_HOSTS_MAX)
  })
})

describe('HelperConsent', () => {
  it('stores answers in a private file and reads them back', () => {
    const path = file()
    const consent = new HelperConsent(path)
    expect(consent.get('db')).toBeUndefined()
    consent.set('db', { answer: 'allowed', version: '0123456789ab', at: 'now' })
    consent.set('web', { answer: 'refused', at: 'now' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const again = new HelperConsent(path)
    expect(again.get('db')).toEqual({ answer: 'allowed', version: '0123456789ab', at: 'now' })
    again.forget('db')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      hosts: { web: { answer: 'refused', at: 'now' } },
    })
  })

  it('starts empty from a damaged file and refuses a key that is not a host', () => {
    const path = file()
    new HelperConsent(path).set('db', { answer: 'refused', at: '' })
    writeFileSync(path, '{broken')
    const consent = new HelperConsent(path)
    expect(consent.all()).toEqual([])
    consent.set('a b', { answer: 'allowed', at: '' })
    expect(consent.all()).toEqual([])
  })

  it('works in memory without a data folder', () => {
    const consent = new HelperConsent(null)
    consent.set('db', { answer: 'refused', at: '' })
    expect(consent.get('db')?.answer).toBe('refused')
  })
})
