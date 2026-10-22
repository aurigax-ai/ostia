import { afterEach, describe, expect, it, vi } from 'vitest'
import { startServerHeartbeat } from './serverHeartbeat'

const DAY = 86_400_000

function account(signedIn = true, fails = false) {
  const heartbeat = vi.fn(async (_token: string) => {
    if (fails) throw new Error('429')
  })
  const authed = vi.fn(
    async (work: (token: string, routes: { heartbeat: typeof heartbeat }) => Promise<unknown>) =>
      work('token', { heartbeat }),
  )
  return { heartbeat, authed, account: { signedIn: () => signedIn, authed } as never }
}

afterEach(() => vi.useRealTimers())

describe('daily heartbeat', () => {
  it('SYA-C200 checks in at start and then every 24 hours while signed in', async () => {
    vi.useFakeTimers()
    const { heartbeat, account: acct } = account()
    const stop = startServerHeartbeat(acct)
    await vi.advanceTimersByTimeAsync(0)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DAY - 1000)
    expect(heartbeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(heartbeat).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(heartbeat).toHaveBeenCalledTimes(2)
  })

  it('SYA-C201 sends nothing while signed out', async () => {
    vi.useFakeTimers()
    const { heartbeat, account: acct } = account(false)
    startServerHeartbeat(acct)
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(heartbeat).not.toHaveBeenCalled()
  })

  it('SYA-C202 shrugs off a refusal and asks again only the next day', async () => {
    vi.useFakeTimers()
    const { heartbeat, account: acct } = account(true, true)
    startServerHeartbeat(acct)
    await vi.advanceTimersByTimeAsync(DAY / 2)
    expect(heartbeat).toHaveBeenCalledTimes(1)
  })
})
