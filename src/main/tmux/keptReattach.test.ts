import { describe, expect, it, vi } from 'vitest'
import { ScreenMirror } from '../terminal/screenMirror'
import { pendingRestoredScrollback, stashScrollback } from '../workspaces/savedScrollback'
import { createKeptReattach } from './keptReattach'

function setup() {
  const writeToken = vi.fn()
  const shown: string[] = []
  const mirror = new ScreenMirror(80, 24)
  const entry = {
    mirror,
    exitListeners: new Set(),
    session: {
      cursor: 0,
      push: (data: string) => shown.push(data),
      since: () => ({ data: shown.join(''), cursor: 0, dropped: false }),
      addLiveSubscriber: vi.fn(),
      exit: vi.fn(),
    },
  }
  const { reattachKept } = createKeptReattach({
    workspaceSandboxes: {} as never,
    keptShells: {
      savedAttention: () => null,
      writeToken,
      keptHost: () => undefined,
    } as never,
    keptPlumbing: { ensure: vi.fn() } as never,
    keptAttention: { reattached: vi.fn() } as never,
    agentRunning: { has: () => false, stillRunning: () => false } as never,
    hibernatedPanes: new Set(),
    portRequests: {} as never,
    trackPty: (() => entry) as never,
    feedPty: ((e: typeof entry, data: string) => {
      e.session.push(data)
      e.mirror.write(data)
    }) as never,
    releaseMergedSandbox: vi.fn(),
    restoreKeptAttention: vi.fn(),
    processes: () => null,
    appLog: () => null,
  })
  const kept = {
    pane: {
      cols: 80,
      rows: 24,
      onData: vi.fn(),
      onExit: vi.fn(),
      snapshot: async () => 'kept screen',
      currentCommand: async () => '',
      live: vi.fn(),
    },
    meta: { workspaceId: 'w1', externalId: 'x', shell: '/bin/bash', spawnPath: '', stateFile: '' },
  }
  return {
    writeToken,
    shown,
    mirror,
    run: () =>
      reattachKept(
        { sender: { id: 1 } } as never,
        'p1',
        {} as never,
        kept as never,
        () => ({}) as never,
      ),
  }
}

describe('reattaching a kept shell', () => {
  it('RSM-C19 shows the restore seam without saving it', async () => {
    const { shown, mirror, run } = setup()
    await run()
    await mirror.flush()
    expect(shown.join('')).toContain('workspace restored')
    expect(mirror.serialize()).toContain('kept screen')
    expect(mirror.serialize()).not.toContain('workspace restored')
    mirror.dispose()
  })

  it('KSH-C72 writes the pane a new token at every reattach', async () => {
    const { writeToken, run } = setup()
    await run()
    await run()
    expect(writeToken).toHaveBeenCalledTimes(2)
    const [[firstPane, first], [secondPane, second]] = writeToken.mock.calls
    expect([firstPane, secondPane]).toEqual(['p1', 'p1'])
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toMatch(/^[0-9a-f]{64}$/)
    expect(second).not.toBe(first)
  })

  it('KSH-C13 drops the pane’s saved scrollback so the kept screen is its only copy', async () => {
    const { run } = setup()
    stashScrollback('p1', 'once-42')
    stashScrollback('other', 'untouched')
    await run()
    expect(pendingRestoredScrollback()).toEqual({ other: 'untouched' })
  })
})
