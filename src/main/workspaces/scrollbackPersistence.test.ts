import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { ScreenMirror } from '../terminal/screenMirror'
import { loadRestoredScrollback, scrollbackPath, stashScrollback } from './savedScrollback'
import { createScrollbackPersistence } from './scrollbackPersistence'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ostia-scrollback-persistence-'))
  vi.stubEnv('XDG_DATA_HOME', dataDir)
  loadRestoredScrollback()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dataDir, { recursive: true, force: true })
})

function persistence(ptys: Map<string, PtyEntry>) {
  return createScrollbackPersistence({
    redactor: { settingsKey: () => 'none', text: async (text: string) => text } as never,
    services: { broker: null },
    ptys,
    isScratchPane: (paneId) => paneId === 'scratch',
    quit: { savingScrollbackForQuit: false, scrollbackSavedForQuit: false },
    quitTrace: { stage: vi.fn(), current: () => 'idle', elapsedMs: () => 0 },
  })
}

async function liveEntry(text: string): Promise<{ entry: PtyEntry; mirror: ScreenMirror }> {
  const mirror = new ScreenMirror(80, 24)
  mirror.write(text)
  await mirror.flush()
  return { entry: { mirror } as PtyEntry, mirror }
}

function saved(): Record<string, string> {
  return JSON.parse(readFileSync(scrollbackPath(), 'utf8'))
}

describe('persistScrollback', () => {
  it('KSH-C13 saves a pane’s screen once when it was also waiting to be restored', async () => {
    const { entry, mirror } = await liveEntry('once-42\r\n')
    stashScrollback('p1', 'once-42\r\n')
    await persistence(new Map([['p1', entry]])).persistScrollback()
    const text = saved().p1
    expect(text.split('once-42').length - 1).toBe(1)
    mirror.dispose()
  })

  it('keeps the saved text of a pane that has not been attached yet', async () => {
    stashScrollback('asleep', 'frozen-screen')
    await persistence(new Map()).persistScrollback()
    expect(saved()).toEqual({ asleep: 'frozen-screen' })
  })

  it('leaves a scratch pane’s screen out of the file', async () => {
    const { entry, mirror } = await liveEntry('scratch-text\r\n')
    await persistence(new Map([['scratch', entry]])).persistScrollback()
    expect(saved()).toEqual({})
    mirror.dispose()
  })
})
