import { describe, expect, it, vi } from 'vitest'
import type { FolderReads } from './folderAccess'
import { createFolderAccessWatch, FOCUS_PROBE_MIN_MS } from './folderAccessWatch'

function setup(opts: { fda?: boolean; main?: FolderReads[]; kept?: (FolderReads | null)[] } = {}) {
  let now = 1_000_000
  const main = [...(opts.main ?? [{ Downloads: 'ok' }])]
  const kept = [...(opts.kept ?? [null])]
  const deps = {
    now: () => now,
    hasFullDiskAccess: vi.fn(async () => opts.fda ?? true),
    readMain: vi.fn(async () => (main.length > 1 ? main.shift() : main[0]) ?? {}),
    readKept: vi.fn(async () => (kept.length > 1 ? kept.shift() : kept[0]) ?? null),
    announce: vi.fn(),
  }
  return {
    deps,
    watch: createFolderAccessWatch(deps),
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('createFolderAccessWatch', () => {
  it('reads no folder when Ostia has no Full Disk Access, so macOS never asks', async () => {
    const { deps, watch } = setup({ fda: false })
    await watch.probe()
    await watch.focused()
    expect(deps.hasFullDiskAccess).toHaveBeenCalled()
    expect(deps.readMain).not.toHaveBeenCalled()
    expect(deps.readKept).not.toHaveBeenCalled()
    expect(deps.announce).not.toHaveBeenCalled()
  })

  it('announces folders the kept shells cannot read while Ostia can, once', async () => {
    const { deps, watch } = setup({
      main: [{ Downloads: 'ok', Documents: 'ok' }],
      kept: [{ Downloads: 'denied', Documents: 'ok' }],
    })
    await watch.probe()
    await watch.probe()
    expect(deps.announce).toHaveBeenCalledTimes(1)
    expect(deps.announce).toHaveBeenCalledWith(['Downloads'])
  })

  it('announces when Ostia itself loses a folder it could read earlier', async () => {
    const { deps, watch } = setup({ main: [{ Documents: 'ok' }, { Documents: 'denied' }] })
    await watch.probe()
    expect(deps.announce).not.toHaveBeenCalled()
    await watch.probe()
    expect(deps.announce).toHaveBeenCalledWith(['Documents'])
  })

  it('probes on focus at most once a minute', async () => {
    const { deps, watch, advance } = setup()
    await watch.focused()
    await watch.focused()
    advance(FOCUS_PROBE_MIN_MS - 1)
    await watch.focused()
    expect(deps.readMain).toHaveBeenCalledTimes(1)
    advance(1)
    await watch.focused()
    expect(deps.readMain).toHaveBeenCalledTimes(2)
  })

  it('counts a timer or reattach probe toward the focus limit', async () => {
    const { deps, watch, advance } = setup()
    await watch.probe()
    advance(1000)
    await watch.focused()
    expect(deps.readMain).toHaveBeenCalledTimes(1)
  })

  it('runs one probe at a time', async () => {
    const { deps, watch } = setup()
    await Promise.all([watch.probe(), watch.probe(), watch.focused()])
    expect(deps.readMain).toHaveBeenCalledTimes(1)
  })

  it('keeps probing after a probe throws', async () => {
    const { deps, watch } = setup()
    deps.readMain.mockRejectedValueOnce(new Error('boom'))
    await expect(watch.probe()).resolves.toBeUndefined()
    await watch.probe()
    expect(deps.readMain).toHaveBeenCalledTimes(2)
  })
})
