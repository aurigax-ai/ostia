import { describe, expect, it } from 'vitest'
import { AssistFailure } from '../sdk'
import { createFlight } from './flight'

function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(AssistFailure)
  return (err as AssistFailure).code
}

describe('createFlight', () => {
  it('runs a task at once when nothing is in flight', async () => {
    const flight = createFlight()
    expect(await flight.run(new AbortController().signal, async () => 'a')).toBe('a')
  })

  it('holds a new task until the one in flight lands, and runs only the latest', async () => {
    const flight = createFlight()
    const first = deferred<string>()
    const started: string[] = []
    const one = flight.run(new AbortController().signal, () => {
      started.push('one')
      return first.promise
    })
    await Promise.resolve()
    const two = flight.run(new AbortController().signal, async () => {
      started.push('two')
      return 'two'
    })
    const three = flight.run(new AbortController().signal, async () => {
      started.push('three')
      return 'three'
    })
    expect(await codeOf(two)).toBe('cancelled')
    expect(started).toEqual(['one'])
    first.resolve('one')
    expect(await one).toBe('one')
    expect(await three).toBe('three')
    expect(started).toEqual(['one', 'three'])
  })

  it('answers cancelled when aborted in flight but keeps the slot until the task lands', async () => {
    const flight = createFlight()
    const first = deferred<string>()
    const abort = new AbortController()
    const one = flight.run(abort.signal, () => first.promise)
    await Promise.resolve()
    abort.abort()
    expect(await codeOf(one)).toBe('cancelled')
    let ran = false
    const two = flight.run(new AbortController().signal, async () => {
      ran = true
      return 'two'
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(ran).toBe(false)
    first.resolve('late')
    expect(await two).toBe('two')
  })

  it('never starts a waiting task whose request was cancelled', async () => {
    const flight = createFlight()
    const first = deferred<string>()
    const one = flight.run(new AbortController().signal, () => first.promise)
    await Promise.resolve()
    const abort = new AbortController()
    let ran = false
    const two = flight.run(abort.signal, async () => {
      ran = true
      return 'two'
    })
    abort.abort()
    expect(await codeOf(two)).toBe('cancelled')
    first.resolve('one')
    await one
    expect(ran).toBe(false)
  })

  it('frees the slot when a task fails', async () => {
    const flight = createFlight()
    await expect(
      flight.run(new AbortController().signal, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await flight.run(new AbortController().signal, async () => 'ok')).toBe('ok')
  })
})
