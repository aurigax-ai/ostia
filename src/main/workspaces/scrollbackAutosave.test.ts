import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { createScrollbackPersistence } from './scrollbackPersistence'

const saveScrollback = vi.hoisted(() => vi.fn(async (_byPane: Record<string, string>) => undefined))

vi.mock('./savedScrollback', () => ({
  pendingRestoredScrollback: () => ({}),
  scrollbackToSave: (byPane: Record<string, string>) => byPane,
  saveScrollback,
}))

vi.mock('../privacy/redaction', () => ({
  createScrollbackRedactor: () => async (byPane: Record<string, string>) => byPane,
}))

describe('autosaveScrollback', () => {
  const pane = { revision: 1 }
  let persistence: ReturnType<typeof createScrollbackPersistence>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    saveScrollback.mockClear()
    pane.revision = 1
    const entry = {
      mirror: {
        get revision() {
          return pane.revision
        },
        serialize: () => `text ${pane.revision}`,
      },
    } as unknown as PtyEntry
    persistence = createScrollbackPersistence({
      redactor: { settingsKey: () => '', text: async (text: string) => text },
      services: { broker: null },
      ptys: new Map([['a', entry]]),
      isScratchPane: () => false,
      quit: { savingScrollbackForQuit: false, scrollbackSavedForQuit: false },
      quitTrace: { stage: () => undefined },
    } as unknown as Parameters<typeof createScrollbackPersistence>[0])
  })

  afterEach(() => vi.useRealTimers())

  async function tick(): Promise<void> {
    vi.advanceTimersByTime(persistence.SCROLLBACK_AUTOSAVE_MS)
    persistence.autosaveScrollback()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('saves a change after a quiet tick on the next tick, however recent the last save', async () => {
    pane.revision++
    await tick()
    await tick()
    pane.revision++
    await tick()
    expect(saveScrollback).toHaveBeenCalledTimes(2)
    expect(saveScrollback).toHaveBeenLastCalledWith({ a: `text ${pane.revision}` })
  })

  it('does not save again while the panes stay quiet', async () => {
    pane.revision++
    await tick()
    await tick()
    await tick()
    expect(saveScrollback).toHaveBeenCalledTimes(1)
  })

  it('saves the second changed tick in a row, so a short build is never held', async () => {
    pane.revision++
    await tick()
    pane.revision++
    await tick()
    expect(saveScrollback).toHaveBeenCalledTimes(2)
  })

  it('saves a streaming pane once per three ticks and still saves its last change', async () => {
    const saves: number[] = []
    for (let i = 0; i < 6; i++) {
      pane.revision++
      await tick()
      saves.push(saveScrollback.mock.calls.length)
    }
    expect(saves).toEqual([1, 2, 2, 2, 3, 3])
    await tick()
    expect(saveScrollback).toHaveBeenCalledTimes(4)
    expect(saveScrollback).toHaveBeenLastCalledWith({ a: `text ${pane.revision}` })
    await tick()
    expect(saveScrollback).toHaveBeenCalledTimes(4)
  })
})
