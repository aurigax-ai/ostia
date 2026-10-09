import { describe, expect, it, vi } from 'vitest'
import { OpenWaits } from './openWaits'

const request = { windowId: '1', workspaceId: 'w1', callerPaneId: 'term', paneIds: ['a', 'b'] }

async function outcomeOf(done: Promise<string>): Promise<string> {
  return Promise.race([done, new Promise<string>((ok) => setTimeout(() => ok('waiting'), 20))])
}

describe('OpenWaits', () => {
  it('ends with closed only when the last waited tab is closed', async () => {
    const ended = vi.fn()
    const waits = new OpenWaits(ended)
    const wait = waits.start(request)
    waits.paneClosed('a')
    waits.paneClosed('unrelated')
    expect(await outcomeOf(wait.done)).toBe('waiting')
    waits.paneClosed('b')
    expect(await wait.done).toBe('closed')
    expect(ended.mock.calls).toEqual([['1', ['a', 'b']]])
    expect(waits.size).toBe(0)
  })

  it.each([
    ['a waited tab moved out of reach', (w: OpenWaits) => w.paneMoved('a')],
    ['the caller’s pane moved', (w: OpenWaits) => w.paneMoved('term')],
    ['the workspace closed', (w: OpenWaits) => w.workspaceClosed('w1')],
    ['the window or its renderer went away', (w: OpenWaits) => w.windowGone('1')],
    ['the caller’s shell exited', (w: OpenWaits) => w.callerExited('term')],
    ['the caller’s pane closed', (w: OpenWaits) => w.paneClosed('term')],
  ])('ends with gone and leaves nothing behind when %s', async (_name, cause) => {
    const waits = new OpenWaits()
    const wait = waits.start(request)
    cause(waits)
    expect(await wait.done).toBe('gone')
    expect(waits.size).toBe(0)
  })

  it('ends with gone when the command’s connection closes, and tells the window to drop the line', async () => {
    const ended = vi.fn()
    const waits = new OpenWaits(ended)
    const wait = waits.start(request)
    waits.cancel(wait.id)
    expect(await wait.done).toBe('gone')
    expect(ended).toHaveBeenCalledWith('1', ['a', 'b'])
    waits.cancel(wait.id)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('leaves other waits alone', async () => {
    const waits = new OpenWaits()
    const mine = waits.start(request)
    const other = waits.start({ ...request, workspaceId: 'w2', callerPaneId: 't2', paneIds: ['c'] })
    waits.workspaceClosed('w1')
    expect(await mine.done).toBe('gone')
    expect(await outcomeOf(other.done)).toBe('waiting')
    waits.paneClosed('c')
    expect(await other.done).toBe('closed')
  })

  it('ends at once when no tab was opened', async () => {
    const waits = new OpenWaits()
    expect(await waits.start({ ...request, paneIds: [] }).done).toBe('gone')
    expect(waits.size).toBe(0)
  })
})
