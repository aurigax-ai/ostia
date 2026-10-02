import { afterEach, describe, expect, it } from 'vitest'
import { type RemoteHost, helperSource, remoteHost } from '../../../test/fixtures/ssh/remoteHost'
import { HelperFailure } from './channel'
import { shippedHelper } from './helper'
import { HelperHosts } from './helperHosts'
import { type ConnectPlan, hostKey, planConnect } from './plan'

const helper = shippedHelper(helperSource())
function planned(argv: string[]): ConnectPlan {
  const plan = planConnect(argv)
  if (!plan) throw new Error('plan')
  return plan
}

const plan = planned(['dev@db'])
const key = hostKey(plan)

let remote: RemoteHost | null = null
let hosts: HelperHosts | null = null

function setup(idleCloseMs = 60_000): { remote: RemoteHost; hosts: HelperHosts } {
  remote = remoteHost()
  hosts = new HelperHosts({ helper, spawn: remote.spawn, idleCloseMs })
  return { remote, hosts }
}

afterEach(() => {
  hosts?.closeAll()
  remote?.cleanup()
  hosts = null
  remote = null
})

function runsOf(made: RemoteHost): number {
  return made.runs().filter((line) => line.includes(helper.commands.run.slice(0, 40))).length
}

describe('HelperHosts', () => {
  it('SSH-C51 serves every use of one host with one ssh process', async () => {
    const { remote, hosts } = setup()
    await hosts.install(plan)
    const [first, second] = await Promise.all([hosts.channel(plan), hosts.channel(plan)])
    expect(first).toBe(second)
    expect(await hosts.channel(plan)).toBe(first)
    expect(runsOf(remote)).toBe(1)
    expect(hosts.isConnected(key)).toBe(true)
  })

  it('SSH-C51 closes the channel once nothing uses it and the grace passed', async () => {
    const { remote, hosts } = setup(150)
    await hosts.install(plan)
    const channel = await hosts.channel(plan)
    hosts.retain(key)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(channel.isClosed).toBe(false)
    hosts.release(key)
    await expect.poll(() => channel.isClosed, { timeout: 3000 }).toBe(true)
    expect(hosts.isConnected(key)).toBe(false)
    const again = await hosts.channel(plan)
    expect(again).not.toBe(channel)
    expect(runsOf(remote)).toBe(2)
  })

  it('reopens after ssh died and reports a host without the helper', async () => {
    const { hosts } = setup()
    await expect(hosts.channel(plan)).rejects.toMatchObject({ code: 'missing' })
    await hosts.install(plan)
    const channel = await hosts.channel(plan)
    channel.close()
    const next = await hosts.channel(plan)
    expect(next.isClosed).toBe(false)
    await hosts.remove(plan)
    expect(next.isClosed).toBe(true)
    await expect(hosts.channel(plan)).rejects.toBeInstanceOf(HelperFailure)
  })
})
