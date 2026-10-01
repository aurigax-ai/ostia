import { describe, expect, it } from 'vitest'
import {
  VIOLATIONS_PER_WORKSPACE,
  VIOLATION_TEXT_MAX,
  ViolationLog,
  parseViolationLine,
  recordViolations,
} from './violations'

describe('parseViolationLine', () => {
  it('reads a refused connection as host:port with why it was refused', () => {
    expect(
      parseViolationLine('deny network-outbound example.com:443 (host is not on the allow list)'),
    ).toEqual({
      kind: 'network',
      target: 'example.com:443',
      reason: 'not-allowed',
      detail: '',
      allowHost: 'example.com',
    })
    expect(parseViolationLine('deny network-outbound Example.com:443 (user denied)')).toMatchObject(
      { reason: 'refused', allowHost: 'example.com' },
    )
  })

  it('offers no Allow for a host on the blocked list, an address refusal or an IP literal', () => {
    const blocked = parseViolationLine(
      'deny network-outbound ads.example.com:80 (host is on the deny list)',
    )
    expect(blocked).toMatchObject({ reason: 'blocked', target: 'ads.example.com:80' })
    expect(blocked.allowHost).toBeUndefined()
    const address = parseViolationLine(
      'deny network-outbound intranet.test:80 (resolved to a loopback address)',
    )
    expect(address).toMatchObject({ reason: 'address', detail: 'resolved to a loopback address' })
    expect(address.allowHost).toBeUndefined()
    const literal = parseViolationLine(
      'deny network-outbound 10.0.0.5:22 (host is not on the allow list)',
    )
    expect(literal).toMatchObject({ reason: 'not-allowed', target: '10.0.0.5:22' })
    expect(literal.allowHost).toBeUndefined()
  })

  it('reads a refused HTTP request with its URL', () => {
    expect(
      parseViolationLine(
        'deny http-request GET https://registry.npmjs.org/evil/-/evil-1.0.0.tgz (blocked)',
      ),
    ).toEqual({
      kind: 'network',
      target: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
      reason: 'request',
      detail: 'blocked',
    })
  })

  it('reads a Linux write attempt as the path and the system call', () => {
    expect(parseViolationLine('deny openat /etc/hosts')).toEqual({
      kind: 'write',
      target: '/etc/hosts',
      reason: 'outside',
      detail: 'openat',
    })
    expect(parseViolationLine('deny unlinkat /home/u/My Files/a b.txt')).toMatchObject({
      target: '/home/u/My Files/a b.txt',
    })
  })

  it('reads a macOS sandbox log line by its operation', () => {
    expect(parseViolationLine('cat(4821) deny(1) file-read-data /Users/u/.ssh/id_ed25519')).toEqual(
      {
        kind: 'read',
        target: '/Users/u/.ssh/id_ed25519',
        reason: 'other',
        detail: 'file-read-data',
      },
    )
    expect(parseViolationLine('touch(9) deny(1) file-write-create /etc/x').kind).toBe('write')
    expect(parseViolationLine('curl(9) deny(1) network-outbound /var/run/x.sock').kind).toBe(
      'network',
    )
  })

  it('keeps an unknown line as it is, without control characters and clipped', () => {
    expect(parseViolationLine('something else\u001b[31m happened')).toEqual({
      kind: 'other',
      target: 'something else[31m happened',
      reason: 'other',
      detail: '',
    })
    expect(parseViolationLine(`deny openat /${'a'.repeat(2000)}`).target.length).toBeLessThan(
      VIOLATION_TEXT_MAX,
    )
  })
})

describe('ViolationLog', () => {
  it('keeps each workspace apart', () => {
    const log = new ViolationLog(() => 1)
    log.add('a', parseViolationLine('deny openat /etc/a'))
    log.add('b', parseViolationLine('deny openat /etc/b'))
    expect(log.list('a').map((v) => v.target)).toEqual(['/etc/a'])
    expect(log.list('b').map((v) => v.target)).toEqual(['/etc/b'])
    expect(log.list('c')).toEqual([])
  })

  it('counts a repeat on its row, stamps the latest time and lists the newest first', () => {
    let now = 100
    const log = new ViolationLog(() => now)
    log.add('a', parseViolationLine('deny openat /etc/a'))
    now = 200
    log.add('a', parseViolationLine('deny openat /etc/b'))
    now = 300
    log.add('a', parseViolationLine('deny openat /etc/a'))
    expect(log.list('a').map((v) => [v.target, v.count, v.last])).toEqual([
      ['/etc/a', 2, 300],
      ['/etc/b', 1, 200],
    ])
  })

  it('drops the oldest rows past the cap', () => {
    const log = new ViolationLog(() => 1)
    for (let i = 0; i < VIOLATIONS_PER_WORKSPACE + 25; i += 1) {
      log.add('a', parseViolationLine(`deny openat /etc/f${i}`))
    }
    const list = log.list('a')
    expect(list).toHaveLength(VIOLATIONS_PER_WORKSPACE)
    expect(list[0].target).toBe(`/etc/f${VIOLATIONS_PER_WORKSPACE + 24}`)
    expect(list.at(-1)?.target).toBe('/etc/f25')
  })

  it('clears one workspace and leaves the others', () => {
    const log = new ViolationLog(() => 1)
    log.add('a', parseViolationLine('deny openat /etc/a'))
    log.add('b', parseViolationLine('deny openat /etc/b'))
    log.clear('a')
    expect(log.list('a')).toEqual([])
    expect(log.list('b')).toHaveLength(1)
  })

  it('hands out copies, so a reader cannot change what is stored', () => {
    const log = new ViolationLog(() => 1)
    log.add('a', parseViolationLine('deny openat /etc/a'))
    log.list('a')[0].count = 99
    expect(log.list('a')[0].count).toBe(1)
  })
})

describe('recordViolations', () => {
  it('drops a reported write that the current policy allows, and says which rule refused the rest', () => {
    const log = new ViolationLog(() => 1)
    const refusal = (path: string): 'outside' | 'read-only' | null => {
      if (path.startsWith('/home/u/builds/release')) return 'read-only'
      return path.startsWith('/home/u/builds') ? null : 'outside'
    }
    recordViolations(log, refusal, 'a', [
      'deny openat /home/u/builds/out.bin',
      'deny openat /home/u/builds/release/v1',
      'deny openat /etc/hosts',
      'deny network-outbound example.com:443 (user denied)',
    ])
    expect(log.list('a').map((v) => [v.target, v.reason])).toEqual([
      ['example.com:443', 'refused'],
      ['/etc/hosts', 'outside'],
      ['/home/u/builds/release/v1', 'read-only'],
    ])
  })
})
