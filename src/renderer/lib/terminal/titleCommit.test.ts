import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TITLE_COMMIT_MS, createTitleCommitter } from './titleCommit'

describe('createTitleCommitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits the first title at once', () => {
    const commit = vi.fn()
    createTitleCommitter(commit).push('✳ Task')
    expect(commit.mock.calls).toEqual([['✳ Task']])
  })

  it('commits a spinner that changes every frame at most once per interval', () => {
    const commit = vi.fn()
    const titles = createTitleCommitter(commit)
    for (let frame = 0; frame < 300; frame++) {
      titles.push(`frame ${frame}`)
      vi.advanceTimersByTime(33)
    }
    const seconds = (300 * 33) / TITLE_COMMIT_MS
    expect(commit.mock.calls.length).toBeLessThanOrEqual(Math.ceil(seconds) + 1)
    expect(commit.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(seconds))
  })

  it('commits the last title once the changes stop', () => {
    const commit = vi.fn()
    const titles = createTitleCommitter(commit)
    titles.push('⠋ Task')
    titles.push('⠙ Task')
    titles.push('✳ Task')
    expect(commit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(TITLE_COMMIT_MS)
    expect(commit.mock.calls).toEqual([['⠋ Task'], ['✳ Task']])
    vi.advanceTimersByTime(TITLE_COMMIT_MS * 3)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('commits a title set after a quiet interval at once', () => {
    const commit = vi.fn()
    const titles = createTitleCommitter(commit)
    titles.push('one')
    vi.advanceTimersByTime(TITLE_COMMIT_MS + 1)
    titles.push('two')
    expect(commit.mock.calls).toEqual([['one'], ['two']])
  })

  it('commits nothing more once it is cancelled', () => {
    const commit = vi.fn()
    const titles = createTitleCommitter(commit)
    titles.push('one')
    titles.push('two')
    titles.cancel()
    vi.advanceTimersByTime(TITLE_COMMIT_MS * 2)
    expect(commit.mock.calls).toEqual([['one']])
  })
})
