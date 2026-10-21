import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dict } from '../../shared/app/dict'
import { en } from '../../shared/app/dict'
import type { NotifyWiring } from '../attention/notifyWiring'
import type { AppLog } from '../diagnostics/appLog'
import type { FolderReads } from './folderAccess'
import { PERIODIC_PROBE_MS } from './folderAccessWatch'
import { keptShellsDir } from './keptPaths'
import type { KeptShells } from './keptShells'

const mocks = vi.hoisted(() => ({
  app: { on: vi.fn(), getPath: vi.fn(() => '/user-data') },
  postNotification: vi.fn(),
  hasFullDiskAccess: vi.fn(async () => true),
  readFoldersInMain: vi.fn(async (): Promise<FolderReads> => ({ Downloads: 'ok' })),
  readFoldersInKeptShells: vi.fn(async (): Promise<FolderReads | null> => null),
  sweepKeptProbes: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('../attention/notify', () => ({ postNotification: mocks.postNotification }))
vi.mock('./folderProbe', () => ({
  hasFullDiskAccess: mocks.hasFullDiskAccess,
  readFoldersInMain: mocks.readFoldersInMain,
  readFoldersInKeptShells: mocks.readFoldersInKeptShells,
  sweepKeptProbes: mocks.sweepKeptProbes,
}))

import { startFolderAccessWatch } from './folderAccessWiring'

const platform = process.platform
const notifyDeps = { tag: 'notify' } as unknown as NotifyWiring['notifyDeps']

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function start(reattached = false) {
  const keptShells = {
    ready: Promise.resolve(),
    reattachedFromOtherOwner: vi.fn(() => reattached),
    runShell: vi.fn(async () => true),
  }
  const appLog = { warn: vi.fn() }
  startFolderAccessWatch({
    keptShells: keptShells as unknown as KeptShells,
    mainStrings: () => en as Dict,
    notifyDeps,
    services: { appLog: appLog as unknown as AppLog },
  })
  return { keptShells, appLog }
}

function focusHandler(): () => void {
  const call = mocks.app.on.mock.calls.find(([event]) => event === 'browser-window-focus')
  if (!call) throw new Error('no focus handler')
  return call[1] as () => void
}

describe('startFolderAccessWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    setPlatform('darwin')
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    setPlatform(platform)
  })

  it('does nothing outside macOS', async () => {
    setPlatform('linux')
    start(true)
    await vi.advanceTimersByTimeAsync(PERIODIC_PROBE_MS * 2)
    expect(mocks.app.on).not.toHaveBeenCalled()
    expect(mocks.sweepKeptProbes).not.toHaveBeenCalled()
    expect(mocks.hasFullDiskAccess).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears old probe folders and probes right after reattaching to another Ostia’s server', async () => {
    const { keptShells } = start(true)
    await vi.advanceTimersByTimeAsync(0)
    const dir = keptShellsDir('/user-data')
    expect(mocks.sweepKeptProbes).toHaveBeenCalledWith(dir)
    expect(mocks.readFoldersInMain).toHaveBeenCalledTimes(1)
    expect(mocks.readFoldersInKeptShells).toHaveBeenCalledTimes(1)
    const [deps] = mocks.readFoldersInKeptShells.mock.calls[0] as unknown as [
      { dir: string; runShell: (s: string) => Promise<boolean> },
    ]
    expect(deps.dir).toBe(dir)
    await deps.runShell('true')
    expect(keptShells.runShell).toHaveBeenCalledWith('true')
  })

  it('waits for a reattach to the server this Ostia started until focus or the timer', async () => {
    start(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.hasFullDiskAccess).not.toHaveBeenCalled()
    focusHandler()()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.readFoldersInMain).toHaveBeenCalledTimes(1)
  })

  it('probes every five minutes', async () => {
    start(false)
    await vi.advanceTimersByTimeAsync(PERIODIC_PROBE_MS - 1)
    expect(mocks.hasFullDiskAccess).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.hasFullDiskAccess).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PERIODIC_PROBE_MS)
    expect(mocks.hasFullDiskAccess).toHaveBeenCalledTimes(2)
  })

  it('reads the kept shells only after the old probe folders are cleared', async () => {
    let clear: () => void = () => undefined
    mocks.sweepKeptProbes.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        clear = () => resolve(undefined)
      }),
    )
    start(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.readFoldersInMain).toHaveBeenCalledTimes(1)
    expect(mocks.readFoldersInKeptShells).not.toHaveBeenCalled()
    clear()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.readFoldersInKeptShells).toHaveBeenCalledTimes(1)
  })

  it('names the blocked folders in the notification and logs them', async () => {
    mocks.readFoldersInMain.mockResolvedValueOnce({ Downloads: 'ok', Documents: 'ok' })
    mocks.readFoldersInKeptShells.mockResolvedValueOnce({
      Downloads: 'denied',
      Documents: 'denied',
    })
    const { appLog } = start(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.postNotification).toHaveBeenCalledTimes(1)
    expect(mocks.postNotification).toHaveBeenCalledWith(notifyDeps, {
      title: 'macOS is blocking ~/Downloads, ~/Documents',
      body: en.native.folderAccessBlocked.body,
      from: 'kept-shells',
      evenWhenFocused: true,
    })
    expect(appLog.warn).toHaveBeenCalledWith('folder-access-blocked', {
      folders: 'Downloads,Documents',
    })
  })
})
