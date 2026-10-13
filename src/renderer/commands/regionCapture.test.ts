import { registerRegionCapture } from '@/lib/browser/regionCaptures'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPTURE_REGION_COMMAND, registerRegionCaptureCommand } from './regionCapture'
import { commands } from './registry'

describe('browser.captureRegion command', () => {
  const cleanups: (() => void)[] = []

  beforeAll(() => {
    registerRegionCaptureCommand()
  })

  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  const ctx = (activePaneId: string | null) => ({ activeWorkspaceId: 's1', activePaneId })

  it('is a local palette command that agents never see', () => {
    expect(commands.isLocal(CAPTURE_REGION_COMMAND)).toBe(true)
    expect(commands.describe().some((c) => c.id === CAPTURE_REGION_COMMAND)).toBe(false)
    expect(commands.list().find((c) => c.id === CAPTURE_REGION_COMMAND)?.title).toBe(
      'Capture Browser Region',
    )
  })

  it('starts crop mode in the active browser pane only', async () => {
    const browser = vi.fn()
    const other = vi.fn()
    cleanups.push(registerRegionCapture('b1', browser))
    cleanups.push(registerRegionCapture('b2', other))

    const res = await commands.execWith(ctx('b1'), CAPTURE_REGION_COMMAND)

    expect(res).toEqual({ ok: true, result: { started: true } })
    expect(browser).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
  })

  it('fails when the active pane is not a browser pane', async () => {
    const res = await commands.execWith(ctx('t1'), CAPTURE_REGION_COMMAND)
    expect(res.ok).toBe(false)
  })
})
