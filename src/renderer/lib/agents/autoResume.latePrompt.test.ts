import { createPane, findPane, tabsOf } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { RUN_WHEN_IDLE_TIMEOUT_MS } from '@/lib/terminal/blockActions'
import {
  registerOffscreenStarter,
  resetOffscreenStartForTests,
} from '@/lib/terminal/offscreenStart'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAutoResume } from './autoResume'
import { clearResumeClaims } from './resumeFolder'

const resume = { agent: 'claude' as const, id: 'late-1' }
const line = { line: 0 } as LineAnchor

function agentPane(): PaneNode {
  return { ...createPane('terminal'), resume, resumePending: true }
}

function seed(...panes: PaneNode[]): void {
  useSettingsStore.setState((s) => ({ agents: { ...s.agents, autoResume: true } }))
  useLayoutStore.setState({
    byWorkspace: {
      w1: { root: tabsOf(panes[0].id, ...panes), activePaneId: panes[0].id, zoomedPaneId: null },
    },
  })
}

function shellStarts(paneId: string): ReturnType<typeof vi.fn> {
  const paste = vi.fn()
  registerTerminal(paneId, { paste, focus: vi.fn() } as unknown as OstiaTerminal)
  return paste
}

function promptArrives(paneId: string): void {
  useBlocksStore.getState().promptStart(paneId, line, '/w')
  useBlocksStore.getState().promptEnd(paneId, line)
}

const pending = (id: string) =>
  findPane(useLayoutStore.getState().byWorkspace.w1.root, id)?.resumePending

describe('startAutoResume with a late prompt', () => {
  let stop: (() => void) | null = null
  const write = vi.fn()
  const init = {
    layout: useLayoutStore.getState(),
    settings: useSettingsStore.getState(),
    blocks: useBlocksStore.getState(),
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('ostia', {
      pty: { write },
      agentSession: { claimResume: vi.fn().mockResolvedValue({ ok: true }) },
    })
  })

  afterEach(() => {
    stop?.()
    stop = null
    write.mockClear()
    clearResumeClaims()
    resetOffscreenStartForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    useLayoutStore.setState(init.layout, true)
    useSettingsStore.setState(init.settings, true)
    useBlocksStore.setState(init.blocks, true)
  })

  it('types the resume when the prompt arrives after the idle timeout', async () => {
    const shown = agentPane()
    const background = agentPane()
    seed(shown, background)
    stop = startAutoResume()

    vi.advanceTimersByTime(RUN_WHEN_IDLE_TIMEOUT_MS * 2)
    const paste = shellStarts(background.id)
    promptArrives(background.id)
    await vi.advanceTimersByTimeAsync(0)

    expect(paste).toHaveBeenCalledWith('claude --resume late-1')
    expect(write).toHaveBeenCalledWith(background.id, '\r')
  })

  it('asks a pane that is not shown to start its shell', () => {
    const shown = agentPane()
    const background = agentPane()
    const started: string[] = []
    registerOffscreenStarter(shown.id, () => started.push(shown.id))
    seed(shown, background)
    stop = startAutoResume()
    registerOffscreenStarter(background.id, () => started.push(background.id))

    expect(started).toEqual([shown.id, background.id])
  })

  it('does not resume a pane that ran a command before its prompt was ready', () => {
    const pane = agentPane()
    seed(pane)
    stop = startAutoResume()

    vi.advanceTimersByTime(RUN_WHEN_IDLE_TIMEOUT_MS * 2)
    const paste = shellStarts(pane.id)
    useBlocksStore.getState().commandStart(pane.id, line, 'ls')
    expect(pending(pane.id)).toBeUndefined()
    useBlocksStore.getState().commandEnd(pane.id, line, 0)
    promptArrives(pane.id)

    expect(paste).not.toHaveBeenCalled()
  })
})
