import { describe, expect, it, vi } from 'vitest'
import { composerModeFor, latestRequest, naturalCommandQuery, wordDiff } from './assistComposer'

describe('composerModeFor', () => {
  const base = { agent: false, idlePrompt: false, inputReady: true, commandReady: true }

  it('picks the agent composer while an agent runs and input assist is ready', () => {
    expect(composerModeFor({ ...base, agent: true })).toBe('agent')
    expect(composerModeFor({ ...base, agent: true, inputReady: false })).toBeNull()
  })

  it('picks the command composer at an idle shell prompt', () => {
    expect(composerModeFor({ ...base, idlePrompt: true })).toBe('shell')
    expect(composerModeFor({ ...base, idlePrompt: true, commandReady: false })).toBeNull()
  })

  it('opens nothing while a non-agent command runs', () => {
    expect(composerModeFor(base)).toBeNull()
  })
})

describe('wordDiff', () => {
  it('marks only the words the correction changed', () => {
    const parts = wordDiff('fix teh bug in teh parser', 'fix the bug in the parser')
    expect(parts.filter((p) => p.changed).map((p) => p.text)).toEqual(['the', 'the'])
    expect(parts.map((p) => p.text).join('')).toBe('fix the bug in the parser')
  })

  it('reports no change for identical text', () => {
    expect(wordDiff('same text', 'same text')).toEqual([
      { at: 0, text: 'same text', changed: false },
    ])
  })

  it('keeps offsets into the corrected text', () => {
    expect(wordDiff('a b', 'a c')).toEqual([
      { at: 0, text: 'a ', changed: false },
      { at: 2, text: 'c', changed: true },
    ])
  })
})

describe('latestRequest', () => {
  it('aborts the previous request and only runs the latest after the delay', async () => {
    vi.useFakeTimers()
    const latest = latestRequest()
    const seen: { value: string; signal: AbortSignal }[] = []
    latest.run(async (signal) => void seen.push({ value: 'first', signal }), 100)
    latest.run(async (signal) => void seen.push({ value: 'second', signal }), 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(seen.map((s) => s.value)).toEqual(['second'])
    latest.run(async () => {}, 100)
    expect(seen[0].signal.aborted).toBe(true)
    latest.cancel()
    vi.useRealTimers()
  })
})

describe('naturalCommandQuery', () => {
  it('reads a query after a leading "# "', () => {
    expect(naturalCommandQuery('# list big files ')).toBe('list big files')
  })

  it('ignores short queries and plain commands', () => {
    expect(naturalCommandQuery('# ls')).toBeNull()
    expect(naturalCommandQuery('ls -la')).toBeNull()
    expect(naturalCommandQuery('#nospace here')).toBeNull()
  })
})
