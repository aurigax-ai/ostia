import type { OpenFileVerdict } from '@shared/openFiles'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { allPanes, resetIds, tabsOfPane } from '../layout/tree'
import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { OSTIA_PATH_MIME } from './dropPaths'
import { FILE_DRAG_ATTRIBUTE, startFileDropTracking } from './fileDrop'
import { PANE_DND } from './paneDrag'

interface DroppedFile {
  path: string
}

function dragEvent(type: string, types: string[], files: DroppedFile[] = []): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, getData: () => '', dropEffect: 'none' },
  })
  return event as DragEvent
}

function admitAll(): void {
  vi.mocked(window.ostia.files.admitDropped).mockImplementation(async (files) =>
    files.map(
      (file): OpenFileVerdict => ({ ok: true, path: (file as unknown as DroppedFile).path }),
    ),
  )
}

async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function paneElement(paneId: string): {
  frame: HTMLElement
  header: HTMLElement
  body: HTMLElement
} {
  const frame = document.createElement('div')
  frame.className = 'pane'
  frame.dataset.paneId = paneId
  const header = document.createElement('div')
  const body = document.createElement('div')
  frame.append(header, body)
  document.body.append(frame)
  return { frame, header, body }
}

describe('file drops', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let revealInit: ReturnType<typeof useEditorRevealStore.getState>
  let stop: () => void

  const layout = () => {
    const id = useWorkspacesStore.getState().activeWorkspaceId as string
    return useLayoutStore.getState().byWorkspace[id]
  }
  const editorPaths = () =>
    allPanes(layout().root)
      .filter((p) => p.kind === 'editor')
      .map((p) => p.filePath)

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    revealInit = useEditorRevealStore.getState()
  })

  beforeEach(() => {
    admitAll()
    stop = startFileDropTracking()
  })

  afterEach(() => {
    stop()
    document.body.replaceChildren()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useEditorRevealStore.setState(revealInit, true)
    resetIds()
    vi.useRealTimers()
  })

  function twoPaneWorkspace(): { first: string; second: string } {
    useWorkspacesStore.getState().addWorkspace('/w')
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId as string
    useLayoutStore.getState().ensure(workspaceId)
    const first = layout().activePaneId
    useLayoutStore.getState().split(workspaceId, first, 'horizontal')
    const second = allPanes(layout().root).find((p) => p.id !== first)?.id as string
    useLayoutStore.getState().focusPane(workspaceId, first)
    return { first, second }
  }

  it('lets an OS file drag drop anywhere in the window and marks it while it lasts', () => {
    vi.useFakeTimers()
    const over = dragEvent('dragover', ['Files'])
    document.body.dispatchEvent(over)

    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('copy')
    expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(true)

    vi.advanceTimersByTime(60_000)
    expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(true)

    document.body.dispatchEvent(dragEvent('drop', ['Files']))
    expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(false)
  })

  it('stops marking a file drag that ended elsewhere when the pointer is back', () => {
    for (const type of ['mousemove', 'mousedown', 'wheel']) {
      document.body.dispatchEvent(dragEvent('dragenter', ['Files']))
      expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(true)

      document.body.dispatchEvent(new Event(type, { bubbles: true }))
      expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(false)
    }
  })

  it('leaves pane drags and file-tree rows to their own handlers', async () => {
    twoPaneWorkspace()
    for (const types of [[PANE_DND], [OSTIA_PATH_MIME], ['text/plain']]) {
      const over = dragEvent('dragover', types)
      const drop = dragEvent('drop', types, [{ path: '/tmp/a.txt' }])
      document.body.dispatchEvent(over)
      document.body.dispatchEvent(drop)
      expect(over.defaultPrevented).toBe(false)
      expect(drop.defaultPrevented).toBe(false)
      expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(false)
    }
    await settled()
    expect(window.ostia.files.admitDropped).not.toHaveBeenCalled()
  })

  it('opens nothing when the terminal body already took the drop', async () => {
    const { first } = twoPaneWorkspace()
    const { body } = paneElement(first)
    body.addEventListener('dragover', (e) => e.preventDefault())
    body.addEventListener('drop', (e) => e.preventDefault())

    const over = dragEvent('dragover', ['Files'])
    body.dispatchEvent(over)
    body.dispatchEvent(dragEvent('drop', ['Files'], [{ path: '/tmp/a.txt' }]))
    await settled()

    expect(over.dataTransfer?.dropEffect).toBe('none')
    expect(window.ostia.files.admitDropped).not.toHaveBeenCalled()
    expect(editorPaths()).toEqual([])
  })

  it('opens each dropped file as a tab in the stack of the pane it landed on', async () => {
    const { first, second } = twoPaneWorkspace()
    const { header } = paneElement(second)

    const drop = dragEvent('drop', ['Files'], [{ path: '/tmp/a.txt' }, { path: '/mnt/b.png' }])
    header.dispatchEvent(drop)
    await settled()

    expect(drop.defaultPrevented).toBe(true)
    expect(window.ostia.files.admitDropped).toHaveBeenCalledWith(
      [{ path: '/tmp/a.txt' }, { path: '/mnt/b.png' }],
      useWorkspacesStore.getState().activeWorkspaceId,
    )
    const stack = tabsOfPane(layout().root, second)
    expect((stack ? allPanes(stack) : []).map((p) => p.filePath)).toEqual([
      undefined,
      '/tmp/a.txt',
      '/mnt/b.png',
    ])
    expect(tabsOfPane(layout().root, first)).toBeNull()
    expect(document.documentElement.hasAttribute(FILE_DRAG_ATTRIBUTE)).toBe(false)
  })

  it('opens a drop outside every pane in the active pane of the active workspace', async () => {
    const { first } = twoPaneWorkspace()
    const sidebar = document.createElement('aside')
    document.body.append(sidebar)

    sidebar.dispatchEvent(dragEvent('drop', ['Files'], [{ path: '/var/log/x.log' }]))
    await settled()

    expect(
      (tabsOfPane(layout().root, first)?.children ?? []).flatMap(allPanes).map((p) => p.filePath),
    ).toEqual([undefined, '/var/log/x.log'])
  })

  it('opens a workspace for a drop when none is open', async () => {
    document.body.dispatchEvent(dragEvent('drop', ['Files'], [{ path: '/tmp/a.txt' }]))
    await settled()

    expect(window.ostia.files.admitDropped).toHaveBeenCalledWith([{ path: '/tmp/a.txt' }], null)
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1)
    expect(editorPaths()).toEqual(['/tmp/a.txt'])
  })

  it('opens the path main returned and tells the human about what it refused', async () => {
    twoPaneWorkspace()
    vi.mocked(window.ostia.files.admitDropped).mockResolvedValue([
      { ok: true, path: '/data/real.log' },
      { ok: false, path: '/tmp/folder', error: 'directory' },
    ])

    document.body.dispatchEvent(
      dragEvent('drop', ['Files'], [{ path: '/tmp/link.log' }, { path: '/tmp/folder' }]),
    )
    await settled()

    expect(editorPaths()).toEqual(['/data/real.log'])
    expect(window.ostia.notifications.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        title: '/tmp/folder is a folder. Drop files to view them.',
        desktop: false,
      }),
    )
  })

  it('opens no workspace when every dropped item is refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(window.ostia.files.admitDropped).mockResolvedValue([
      { ok: false, path: '/tmp/folder', error: 'directory' },
    ])

    document.body.dispatchEvent(dragEvent('drop', ['Files'], [{ path: '/tmp/folder' }]))
    await settled()

    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('/tmp/folder is a folder'))
    logged.mockRestore()
  })
})
