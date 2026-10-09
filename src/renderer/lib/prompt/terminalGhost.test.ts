import type { CommandBlock } from '@/stores/blocksStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GHOST_DEBOUNCE_MS,
  type GhostBlockers,
  aiContinuation,
  ghostEligible,
  ghostRequester,
  pickGhost,
  recentHistory,
} from './terminalGhost'

const CLEAR: GhostBlockers = {
  composing: false,
  vimNormal: false,
  menuOpen: false,
  naturalOpen: false,
  walking: false,
  collapsed: true,
  caretAtEnd: true,
  dismissed: false,
}

describe('pickGhost', () => {
  it('prefers the history prefix match over the AI continuation', () => {
    expect(pickGhost('git st', CLEAR, 'atus', { line: 'git st', text: 'ash' })).toEqual({
      kind: 'history',
      text: 'atus',
    })
  })

  it('shows the AI continuation when history has nothing', () => {
    expect(pickGhost('git st', CLEAR, '', { line: 'git st', text: 'ash pop' })).toEqual({
      kind: 'ai',
      text: 'ash pop',
    })
  })

  it('keeps the AI ghost while the human types along it and drops it once they diverge', () => {
    const ai = { line: 'git st', text: 'ash pop' }
    expect(pickGhost('git sta', CLEAR, '', ai)).toEqual({ kind: 'ai', text: 'sh pop' })
    expect(pickGhost('git stx', CLEAR, '', ai)).toBeNull()
    expect(pickGhost('git stash pop', CLEAR, '', ai)).toBeNull()
  })

  it('shows nothing while a menu, hint, IME, vim normal mode, selection or history walk is active', () => {
    const ai = { line: 'ls', text: ' -la' }
    for (const key of [
      'composing',
      'vimNormal',
      'menuOpen',
      'naturalOpen',
      'walking',
      'dismissed',
    ]) {
      expect(pickGhost('ls', { ...CLEAR, [key]: true }, 'x', ai)).toBeNull()
    }
    expect(pickGhost('ls', { ...CLEAR, collapsed: false }, 'x', ai)).toBeNull()
    expect(pickGhost('ls', { ...CLEAR, caretAtEnd: false }, 'x', ai)).toBeNull()
    expect(pickGhost('', CLEAR, '', ai)).toBeNull()
  })

  it('computes the remaining continuation only for a matching line', () => {
    expect(aiContinuation('ls -', { line: 'ls', text: ' -la' })).toBe('la')
    expect(aiContinuation('cat', { line: 'ls', text: ' -la' })).toBe('')
    expect(aiContinuation('ls', null)).toBe('')
  })
})

describe('ghostEligible', () => {
  it('asks only for a single-line, non-empty command that is not a # request', () => {
    expect(ghostEligible('docker ps')).toBe(true)
    expect(ghostEligible('   ')).toBe(false)
    expect(ghostEligible('echo a\necho b')).toBe(false)
    expect(ghostEligible('# list big files')).toBe(false)
  })
})

describe('recentHistory', () => {
  it('keeps the last finished commands with their exit codes, never output', () => {
    const block = (command: string, exitCode: number | null, ended = true): CommandBlock =>
      ({ command, exitCode, endLine: ended ? { line: 1 } : null }) as unknown as CommandBlock
    const blocks = [
      block('a', 0),
      block('b', 1),
      block('c', 0),
      block('d', 0),
      block('e', 2),
      block('f', 0),
      block('running', null, false),
    ]
    expect(recentHistory(blocks)).toEqual([
      { command: 'b', exitCode: 1 },
      { command: 'c', exitCode: 0 },
      { command: 'd', exitCode: 0 },
      { command: 'e', exitCode: 2 },
      { command: 'f', exitCode: 0 },
    ])
  })
})

describe('ghostRequester', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits for a pause in typing and asks once for the latest line', async () => {
    const fetch = vi.fn(async (line: string) => `${line}!`)
    const onResult = vi.fn()
    const r = ghostRequester(fetch, onResult)
    r.request('g')
    r.request('gi')
    r.request('git')
    await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS - 1)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('git')
    expect(onResult).toHaveBeenCalledWith({ line: 'git', text: 'git!' })
  })

  it('aborts a stale request and ignores its late answer', async () => {
    let resolveFirst: (text: string) => void = () => {}
    const signals: AbortSignal[] = []
    const fetch = vi.fn((line: string, signal: AbortSignal) => {
      signals.push(signal)
      return line === 'ls'
        ? new Promise<string>((resolve) => {
            resolveFirst = resolve
          })
        : Promise.resolve(' -la')
    })
    const onResult = vi.fn()
    const r = ghostRequester(fetch, onResult)
    r.request('ls')
    await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS)
    r.request('ls ')
    expect(signals[0].aborted).toBe(true)
    resolveFirst(' stale')
    await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS)
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({ line: 'ls ', text: ' -la' })
  })

  it('answers a line it already asked about from the cache without a request', async () => {
    const fetch = vi.fn(async () => ' status')
    const onResult = vi.fn()
    const r = ghostRequester(fetch, onResult)
    r.request('git')
    await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS)
    r.request('git')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenLastCalledWith({ line: 'git', text: ' status' })
  })
})
