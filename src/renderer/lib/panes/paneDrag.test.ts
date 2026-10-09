import { usePaneDnd } from '@/stores/paneDndStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { reportForeignDrop, startPaneDragTracking } from './paneDrag'

let init: ReturnType<typeof useWorkspacesStore.getState>

beforeAll(() => {
  init = useWorkspacesStore.getState()
})

afterEach(() => {
  useWorkspacesStore.setState(init, true)
})

function seed(kind: 'terminal' | 'scratch'): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'w1', name: 'api', kind, workDir: '/home/u/api', state: 'idle' }],
    activeWorkspaceId: 'w1',
  })
}

describe('reportForeignDrop', () => {
  it('tells main a pane from another window landed in this workspace', () => {
    seed('terminal')
    reportForeignDrop('pane-x', { paneId: 'pane-1', zone: 'right' })
    expect(window.ostia.windows.dropPane).toHaveBeenCalledWith({
      paneId: 'pane-x',
      workspaceId: 'w1',
      placement: { paneId: 'pane-1', zone: 'right' },
    })
  })

  it('never takes a pane from another window into a scratch workspace', () => {
    seed('scratch')
    vi.mocked(window.ostia.windows.dropPane).mockClear()
    reportForeignDrop('pane-x', { paneId: 'pane-1', zone: 'center' })
    expect(window.ostia.windows.dropPane).not.toHaveBeenCalled()
  })
})

describe('startPaneDragTracking', () => {
  let stop: () => void

  afterEach(() => {
    stop()
    usePaneDnd.getState().reset()
  })

  it('takes the drop layer away on a drop even when the dragged tab never reports the drag ended', () => {
    stop = startPaneDragTracking()
    usePaneDnd.getState().start('pane-1')
    usePaneDnd.getState().dropped()

    document.dispatchEvent(new Event('drop', { bubbles: true }))

    expect(usePaneDnd.getState().dragging).toBe(false)
    expect(usePaneDnd.getState().droppedHere).toBe(true)
    expect(usePaneDnd.getState().sourceId).toBe('pane-1')
  })

  it('clears a drag that is still marked active once the pointer moves again', () => {
    stop = startPaneDragTracking()
    usePaneDnd.getState().start('pane-1')

    document.dispatchEvent(new Event('mousemove', { bubbles: true }))

    expect(usePaneDnd.getState()).toMatchObject({
      dragging: false,
      sourceId: null,
      droppedHere: false,
    })
  })

  it('leaves an idle state alone when the pointer moves', () => {
    stop = startPaneDragTracking()
    const before = usePaneDnd.getState()
    document.dispatchEvent(new Event('mousemove', { bubbles: true }))
    expect(usePaneDnd.getState()).toBe(before)
  })
})
