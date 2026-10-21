import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeViewerSelection } from '../contract/viewerSelection'
import { createCellsPublisher } from './cells'

interface Call {
  url: string
  method: string
  body: unknown
}

const RECT = { x: 1, y: 2, width: 30, height: 40 }
const FIRST = { range: { r1: 0, c1: 0, r2: 1, c2: 1 }, rect: RECT }

let calls: Call[] = []

async function bodyOf(init: RequestInit): Promise<unknown> {
  if (!(init.body instanceof Blob)) return null
  return decodeViewerSelection(new Uint8Array(await init.body.arrayBuffer()))?.meta
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: await bodyOf(init) })
      return { ok: true }
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(
  rows: string[][] = [
    ['a', 'b'],
    ['c', 'd,e'],
  ],
) {
  const tooLarge = vi.fn<(tooLarge: boolean) => void>()
  const publisher = createCellsPublisher(
    { sheet: 'Q4', rowOffset: 0, text: (row, column) => rows[row]?.[column] ?? '' },
    tooLarge,
  )
  return { publisher, tooLarge }
}

describe('createCellsPublisher', () => {
  it('posts the cells with the csv and the rectangle once the selection settles', async () => {
    const { publisher } = setup()
    publisher.update(FIRST)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/~selection')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({
      capture: { kind: 'cells', sheet: 'Q4', range: 'A1:B2', rows: 2, columns: 2 },
      rect: RECT,
      csv: 'a,b\nc,"d,e"',
    })
    expect(calls[0].body).not.toHaveProperty('html')
  })

  it('publishes only the last of a burst, and not the same selection twice', async () => {
    const { publisher } = setup()
    publisher.update({ range: { r1: 0, c1: 0, r2: 0, c2: 0 }, rect: RECT })
    publisher.update(FIRST)
    await vi.advanceTimersByTimeAsync(100)
    publisher.update(FIRST)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(1)
    publisher.update({ ...FIRST, rect: { ...RECT, y: 99 } })
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(2)
  })

  it('withdraws the selection at once when it is cleared', async () => {
    const { publisher } = setup()
    publisher.update(FIRST)
    await vi.advanceTimersByTimeAsync(100)
    publisher.update(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
    publisher.clear()
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(2)
  })

  it('drops a pending publish when cleared before it was sent', async () => {
    const { publisher } = setup()
    publisher.update(FIRST)
    publisher.clear()
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([])
  })

  it('says the selection is too large, publishes nothing and withdraws an earlier one', async () => {
    const { publisher, tooLarge } = setup()
    publisher.update(FIRST)
    await vi.advanceTimersByTimeAsync(100)
    publisher.update({ range: { r1: 0, c1: 0, r2: 5_000, c2: 5 }, rect: RECT })
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
    expect(tooLarge).toHaveBeenLastCalledWith(true)
    publisher.update(FIRST)
    await vi.advanceTimersByTimeAsync(100)
    expect(tooLarge).toHaveBeenLastCalledWith(false)
    expect(calls.map((call) => call.method)).toEqual(['POST', 'DELETE', 'POST'])
  })

  it('publishes nothing for a lone empty cell', async () => {
    const { publisher, tooLarge } = setup([['']])
    publisher.update({ range: { r1: 0, c1: 0, r2: 0, c2: 0 }, rect: RECT })
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toEqual([])
    expect(tooLarge).toHaveBeenLastCalledWith(false)
  })
})
