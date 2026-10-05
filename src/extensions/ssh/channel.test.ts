import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUFFER_MAX_BYTES,
  ByteQueue,
  HelperChannel,
  HelperFailure,
  type SpawnSsh,
  parseHeader,
  requestLine,
  runStatus,
} from './channel'

function scripted(script: string): SpawnSsh {
  return () => spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] })
}

async function failure(work: Promise<unknown>): Promise<HelperFailure> {
  try {
    await work
  } catch (err) {
    if (err instanceof HelperFailure) return err
    throw err
  }
  throw new Error('no failure')
}

const channels: HelperChannel[] = []

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close()
})

async function channelOf(script: string, requestTimeoutMs = 15_000): Promise<HelperChannel> {
  const channel = await HelperChannel.open(['ssh'], { spawn: scripted(script), requestTimeoutMs })
  channels.push(channel)
  return channel
}

const STAT = { op: 'stat', number: 0, root: '/r', path: '/r', maxReply: 16 } as const

describe('ByteQueue', () => {
  it('hands out lines and exact byte counts across chunk boundaries', async () => {
    const queue = new ByteQueue()
    queue.push(Buffer.from('1 ok 5 me'))
    const line = queue.line(64)
    queue.push(Buffer.from('ta\nab'))
    expect(await line).toBe('1 ok 5 meta')
    const bytes = queue.bytes(5)
    queue.push(Buffer.from('cde2 ok'))
    expect((await bytes)?.toString()).toBe('abcde')
    queue.end()
    expect(await queue.line(64)).toBeNull()
    expect(await queue.bytes(10)).toBeNull()
  })

  it('ends and reports an overflow when a host sends more than it may buffer', async () => {
    let overflowed = false
    const queue = new ByteQueue(10, () => {
      overflowed = true
    })
    queue.push(Buffer.from('12345'))
    queue.push(Buffer.from('1234567'))
    expect(overflowed).toBe(true)
    expect(await queue.bytes(1)).toBeNull()
    expect(BUFFER_MAX_BYTES).toBeGreaterThan(8 * 1024 * 1024)
  })

  it('refuses a line longer than the limit', async () => {
    const queue = new ByteQueue()
    queue.push(Buffer.alloc(100, 0x61))
    expect((await failure(queue.line(64))).code).toBe('protocol')
  })
})

describe('requestLine', () => {
  it('writes one line with the root and the path split by a tab', () => {
    expect(
      requestLine(4, {
        op: 'read',
        number: 100,
        root: '/srv/app',
        path: '/srv/app/a b',
        maxReply: 100,
      }),
    ).toBe('4 read 100 - /srv/app\t/srv/app/a b\n')
    expect(
      requestLine(5, {
        op: 'write',
        number: 3,
        version: '12-3',
        root: '/r',
        path: '/r/f',
        maxReply: 0,
      }),
    ).toBe('5 write 3 12-3 /r\t/r/f\n')
  })

  it('refuses a path that would start a second request, a relative path and a version with a space', () => {
    const base = { op: 'read', number: 1, root: '/r', maxReply: 1 } as const
    for (const req of [
      { ...base, path: '/r/a\n9 write 0 any /r\t/r/x' },
      { ...base, path: '/r/a\tb' },
      { ...base, path: 'r/a' },
      { ...base, path: '/r/a', root: 'r' },
      { ...base, path: '/r/a', version: 'a b' },
      { ...base, path: '/r/a', version: '' },
      { ...base, path: '/r/a', number: -1 },
      { ...base, path: '/r/a', number: 1.5 },
    ]) {
      expect(() => requestLine(1, req), JSON.stringify(req)).toThrow(HelperFailure)
    }
  })
})

describe('parseHeader', () => {
  it('reads id, status, length and meta', () => {
    expect(parseHeader('7 ok 12 full', 7, 100)).toEqual({ ok: true, length: 12, meta: 'full' })
    expect(parseHeader('7 err 0 outside', 7, 100)).toEqual({
      ok: false,
      length: 0,
      meta: 'outside',
    })
  })

  it('SSH-C49 refuses a wrong id, a bad length, a length over the cap and stray fields', () => {
    for (const line of [
      '8 ok 0 d',
      '7 ok x d',
      '7 ok 101 d',
      '7 ok -1 d',
      '7 yes 0 d',
      '7 ok 0',
      '7 ok 0 two words',
      '7 err 5 outside',
      '7 ok 0 d\u0000',
      '',
    ]) {
      expect(() => parseHeader(line, 7, 100), line).toThrow(HelperFailure)
    }
  })
})

describe('HelperChannel', () => {
  it('SSH-C49 fails the request and closes when a reply breaks the protocol', async () => {
    const channel = await channelOf(
      'echo "OSTIA-HELPER ready 1"; read line; printf "1 ok 999999 d\\n"; sleep 5',
    )
    expect((await failure(channel.request(STAT))).code).toBe('protocol')
    expect(channel.isClosed).toBe(true)
    expect((await failure(channel.request(STAT))).code).toBe('closed')

    const long = await channelOf(
      `echo "OSTIA-HELPER ready 1"; read line; printf '1 ok 0 %0600d\\n' 0; sleep 5`,
    )
    expect((await failure(long.request(STAT))).code).toBe('protocol')
  })

  it('keeps the channel after an error the helper reports, mapping unknown codes to failed', async () => {
    const channel = await channelOf(
      'echo "OSTIA-HELPER ready 1"; read a; echo "1 err 0 outside"; read b; echo "2 err 0 surprise"; read c; echo "3 ok 2 d"; printf hi; sleep 5',
    )
    expect((await failure(channel.request(STAT))).code).toBe('outside')
    expect((await failure(channel.request(STAT))).code).toBe('failed')
    expect((await channel.request(STAT)).payload.toString()).toBe('hi')
  })

  it('never sends a request with a control character in its path, and stays open', async () => {
    const channel = await channelOf('echo "OSTIA-HELPER ready 1"; read a; echo "1 ok 0 d"; sleep 5')
    const bad = await failure(channel.request({ ...STAT, path: '/r\n2 write 0 any /r\t/r/x' }))
    expect(bad.code).toBe('bad-request')
    expect(channel.isClosed).toBe(false)
    expect((await channel.request(STAT)).meta).toBe('d')
  })

  it('kills ssh when a host floods the channel', async () => {
    const channel = await channelOf(
      'echo "OSTIA-HELPER ready 1"; head -c 20000000 /dev/zero; sleep 5',
    )
    await expect.poll(() => channel.isClosed, { timeout: 10_000 }).toBe(true)
    expect((await failure(channel.request(STAT))).code).toBe('closed')
  })

  it('times a silent helper out and closes', async () => {
    const channel = await channelOf('echo "OSTIA-HELPER ready 1"; sleep 5', 200)
    expect((await failure(channel.request(STAT))).code).toBe('timeout')
    expect(channel.isClosed).toBe(true)
  })

  it('SSH-C50 reports why ssh could not connect, clipped to its first line', async () => {
    const err = await failure(
      HelperChannel.open(['ssh'], {
        spawn: scripted(
          `echo "banner"; printf '\\n  dev@db: Permission denied (publickey).\\nsecond line\\n' >&2; exit 255`,
        ),
      }),
    )
    expect(err.code).toBe('connect-failed')
    expect(err.detail).toBe('dev@db: Permission denied (publickey).')
  })

  it('SSH-C50 kills ssh when no status line arrives in time', async () => {
    let killed = false
    const spawnSleep: SpawnSsh = () => {
      const child = spawn('sh', ['-c', 'exec sleep 30'], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.on('exit', (_code, signal) => {
        killed = signal === 'SIGTERM'
      })
      return child
    }
    const err = await failure(
      HelperChannel.open(['ssh'], { spawn: spawnSleep, helloTimeoutMs: 150 }),
    )
    expect(err.code).toBe('timeout')
    await expect.poll(() => killed).toBe(true)
  })

  it('reports a missing ssh program', async () => {
    const err = await failure(
      HelperChannel.open(['ssh'], {
        spawn: () => spawn('/nonexistent/ostia-no-ssh', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
      }),
    )
    expect(err.code).toBe('ssh-missing')
  })

  it('refuses another protocol version and a status it does not know', async () => {
    const newer = await failure(
      HelperChannel.open(['ssh'], { spawn: scripted('echo "OSTIA-HELPER ready 2"; sleep 5') }),
    )
    expect(newer.code).toBe('incompatible')
    const odd = await failure(
      HelperChannel.open(['ssh'], { spawn: scripted('echo "OSTIA-HELPER hello"; sleep 5') }),
    )
    expect(odd.code).toBe('protocol')
  })

  it('gives up on a host that prints more than the noise limit before any status', async () => {
    const err = await failure(
      HelperChannel.open(['ssh'], {
        spawn: scripted(
          'i=0; while [ $i -lt 3000 ]; do echo "motd line of some length ......"; i=$((i+1)); done; sleep 5',
        ),
      }),
    )
    expect(err.code).toBe('protocol')
  })
})

describe('runStatus', () => {
  it('returns the words of the status line and ignores an early exit while writing', async () => {
    const words = await runStatus(['ssh'], Buffer.alloc(300_000, 0x61), {
      spawn: scripted('echo "OSTIA-HELPER needs cksum"'),
    })
    expect(words).toEqual(['needs', 'cksum'])
  })
})
