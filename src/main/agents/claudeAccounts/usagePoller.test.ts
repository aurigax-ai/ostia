import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageAnswer } from './usageApi'
import {
  USAGE_BACKOFF_MAX_MS,
  USAGE_INTERVAL_MS,
  UsagePoller,
  type UsageTarget,
} from './usagePoller'

const MIN = 60_000
const OK: UsageAnswer = {
  kind: 'ok',
  session: { percent: 42, resetsAt: 99 * MIN },
  weekly: { percent: 18, resetsAt: 999 * MIN },
}

let poller: UsagePoller | null = null

afterEach(() => {
  poller?.run(false)
  poller = null
})

function setup(answers: UsageAnswer[], targets: UsageTarget[] = [{ id: 'a', dir: '/a' }]) {
  let now = 0
  let stamp = 's1'
  let token: string | null = 'tok'
  const fetch = vi.fn(async (_token: string) => answers.shift() ?? OK)
  const onChange = vi.fn()
  const list = { targets }
  poller = new UsagePoller({
    targets: async () => list.targets,
    token: async () => (token ? { accessToken: token, stamp } : null),
    stamp: async () => stamp,
    fetch,
    onChange,
    now: () => now,
    tickMs: 1_000_000_000,
  })
  return {
    poller,
    fetch,
    onChange,
    list,
    at: (ms: number) => {
      now = ms
    },
    restamp: (next: string) => {
      stamp = next
    },
    dropToken: () => {
      token = null
    },
  }
}

async function started(t: ReturnType<typeof setup>): Promise<void> {
  t.poller.run(true)
  await vi.waitFor(() => expect(t.fetch).toHaveBeenCalledTimes(1))
  await t.poller.tick()
}

describe('UsagePoller', () => {
  it('asks once when turned on, keeps the answer in memory, and asks again only after 10 minutes', async () => {
    const t = setup([])
    await started(t)
    expect(t.poller.usageOf('a')).toEqual({ session: OK.session, weekly: OK.weekly, checkedAt: 0 })
    expect(t.onChange).toHaveBeenCalled()
    t.at(USAGE_INTERVAL_MS - 1)
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.at(USAGE_INTERVAL_MS)
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(2)
  })

  it('waits as long as a rate limit asks, at least 10 minutes and at most 6 hours', async () => {
    const t = setup([{ kind: 'rate-limited', retryAfterMs: 30 * MIN }])
    await started(t)
    t.at(30 * MIN - 1)
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.at(30 * MIN)
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(2)
  })

  it('doubles the wait for rate limits that name none, up to 6 hours', async () => {
    const limited: UsageAnswer = { kind: 'rate-limited', retryAfterMs: null }
    const t = setup(Array.from({ length: 8 }, () => limited))
    await started(t)
    const waits: number[] = []
    let at = 0
    for (let i = 0; i < 6; i++) {
      let wait = USAGE_INTERVAL_MS
      while (true) {
        t.at(at + wait)
        await t.poller.tick()
        if (t.fetch.mock.calls.length === i + 2) break
        wait += USAGE_INTERVAL_MS
      }
      waits.push(wait)
      at += wait
    }
    expect(waits).toEqual([
      20 * MIN,
      40 * MIN,
      80 * MIN,
      160 * MIN,
      320 * MIN,
      USAGE_BACKOFF_MAX_MS,
    ])
  })

  it('stops after a rejected sign-in until Claude rewrites the credentials', async () => {
    const t = setup([{ kind: 'auth' }])
    await started(t)
    t.at(5 * USAGE_INTERVAL_MS)
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(1)
    t.restamp('s2')
    await t.poller.tick()
    expect(t.fetch).toHaveBeenCalledTimes(2)
  })

  it('sends nothing for an account without a live token and tries again later', async () => {
    const t = setup([])
    t.dropToken()
    t.poller.run(true)
    await t.poller.tick()
    expect(t.fetch).not.toHaveBeenCalled()
    expect(t.poller.usageOf('a')).toBeNull()
  })

  it('forgets everything when turned off and an account that is no longer a target', async () => {
    const t = setup(
      [],
      [
        { id: 'a', dir: '/a' },
        { id: 'b', dir: '/b' },
      ],
    )
    t.poller.run(true)
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalledTimes(2))
    await t.poller.tick()
    t.list.targets = [{ id: 'a', dir: '/a' }]
    await t.poller.tick()
    expect(t.poller.usageOf('b')).toBeNull()
    expect(t.poller.usageOf('a')).not.toBeNull()
    t.poller.run(false)
    expect(t.poller.usageOf('a')).toBeNull()
    t.poller.run(true)
    expect(t.poller.usageOf('a')).toBeNull()
  })

  it('drops an answer that arrives after it was turned off', async () => {
    let release: (answer: UsageAnswer) => void = () => {}
    const t = setup([])
    t.fetch.mockImplementationOnce(
      () =>
        new Promise<UsageAnswer>((resolve) => {
          release = resolve
        }),
    )
    t.poller.run(true)
    await vi.waitFor(() => expect(t.fetch).toHaveBeenCalledTimes(1))
    t.poller.run(false)
    release(OK)
    await Promise.resolve()
    t.poller.run(true)
    expect(t.poller.usageOf('a')).toBeNull()
  })
})
