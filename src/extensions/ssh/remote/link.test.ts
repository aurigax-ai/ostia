import { PassThrough } from 'node:stream'
import type {
  RemoteMailRequest,
  RemoteMailResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteMail'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_ENTRY } from '../../../shared/remote/remoteNode'
import { planConnect } from '../plan'
import { nodeBundle } from './bundle'
import { HostLink } from './link'

function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const written: object[] = []
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) written.push(JSON.parse(line))
  })
  const child = Object.assign(new PassThrough(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      child.killed = true
      stdout.end()
      child.emit('close')
      return true
    }),
  })
  return { child, written, feed: (frame: object) => stdout.write(`${JSON.stringify(frame)}\n`) }
}

const plan = planConnect(['box'])
const bundle = nodeBundle([{ name: NODE_ENTRY, data: Buffer.from('x\n') }])

describe('HostLink', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function open() {
    if (!plan) throw new Error('no plan')
    const fake = fakeChild()
    const calls: RemoteMailRequest[] = []
    const states: boolean[] = []
    const link = new HostLink({
      host: 'box',
      plan,
      bundle,
      spawn: () => fake.child as never,
      remoteMail: async (request): Promise<RemoteMailResult> => {
        calls.push(request)
        return request.op === 'in' && request.mail.to !== 'local1'
          ? { ok: false, error: 'unknown-pane' }
          : { ok: true, out: [] }
      },
      onState: (online) => states.push(online),
    })
    link.start()
    return { ...fake, calls, states, link }
  }

  it('REM-N4 answers refused to a frame with a forged sender or a recipient that is not a desktop pane', async () => {
    const { feed, written, calls, link } = open()
    feed({ t: 'hello-ok', version: bundle.version })
    await vi.advanceTimersByTimeAsync(50)
    feed({ t: 'mail', id: 'a', from: '../../x', to: 'desktop:local1', text: 'forged' })
    feed({ t: 'mail', id: 'b', from: '0123abcd', to: 'local1', text: 'no prefix' })
    feed({ t: 'mail', id: 'c', from: '0123abcd', to: 'desktop:other', text: 'unknown pane' })
    feed({ t: 'mail', id: 'd', from: '0123abcd', to: 'desktop:local1', text: 'fine' })
    await vi.advanceTimersByTimeAsync(50)
    expect(written).toContainEqual({ t: 'refused', id: 'a', reason: 'bad-from' })
    expect(written).toContainEqual({ t: 'refused', id: 'b', reason: 'bad-from' })
    expect(written).toContainEqual({ t: 'refused', id: 'c', reason: 'unknown-pane' })
    expect(written).toContainEqual({ t: 'stored', id: 'd' })
    expect(calls.filter((call) => call.op === 'in')).toHaveLength(2)
    link.stop()
  })

  it('REM-N5 treats a silent link as dead after 45 s and reports the host offline once', async () => {
    const { feed, child, calls, states, link } = open()
    feed({ t: 'hello-ok', version: bundle.version })
    await vi.advanceTimersByTimeAsync(200)
    expect(states).toEqual([true])
    await vi.advanceTimersByTimeAsync(44_000)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(child.kill).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(states).toEqual([true, false])
    expect(calls.filter((call) => call.op === 'link' && !call.online)).toHaveLength(1)
    link.stop()
  })
})
