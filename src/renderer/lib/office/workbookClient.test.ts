import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFICE_LIMITS } from './officeLimits'
import type { WorkbookResult } from './sheetModel'
import { parseWorkbook } from './workbookClient'

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkbookResult>) => void) | null = null
  onerror: (() => void) | null = null
  posted: unknown[] = []
  terminate = vi.fn()
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  answer(result: WorkbookResult): void {
    this.onmessage?.({ data: result } as MessageEvent<WorkbookResult>)
  }
}

function start(bytes = new Uint8Array([1, 2, 3])) {
  const worker = new FakeWorker()
  const parse = parseWorkbook(bytes, 'xlsx', worker as unknown as Worker)
  return { worker, parse }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parseWorkbook', () => {
  it('sends a copy of the bytes and ends the worker once it answers', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { worker, parse } = start(bytes)
    expect(worker.posted).toHaveLength(1)
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    const answer: WorkbookResult = { ok: false, problem: 'failed' }
    worker.answer(answer)
    await expect(parse.result).resolves.toEqual(answer)
    expect(worker.terminate).toHaveBeenCalled()
  })

  it('stops a worker that takes longer than the limit', async () => {
    const { worker, parse } = start()
    vi.advanceTimersByTime(OFFICE_LIMITS.parseMs)
    await expect(parse.result).resolves.toEqual({ ok: false, problem: 'timeout' })
    expect(worker.terminate).toHaveBeenCalled()
  })

  it('refuses a file over the size limit without starting to parse', async () => {
    const { worker, parse } = start(new Uint8Array(OFFICE_LIMITS.fileBytes + 1))
    await expect(parse.result).resolves.toEqual({ ok: false, problem: 'too-large' })
    expect(worker.posted).toHaveLength(0)
    expect(worker.terminate).toHaveBeenCalled()
  })

  it('ends the worker when cancelled', () => {
    const { worker, parse } = start()
    parse.cancel()
    expect(worker.terminate).toHaveBeenCalled()
  })
})
