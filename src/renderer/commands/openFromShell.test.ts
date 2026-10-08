import { OPEN_FILES_COMMAND, REVEAL_FOLDER_COMMAND } from '@shared/openFiles'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { allPanes, findPane, paneBrowserProfile, tabsOfPane } from '../layout/tree'
import { tabMark } from '../lib/attention'
import { callerHasFocus, opensQuietly } from '../lib/callerFocus'
import { followedFolder, treeRoot } from '../lib/revealFolder'
import { useAttentionStore } from '../stores/attentionStore'
import { useFileTreeStore } from '../stores/fileTreeStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { registerBuiltinCommands } from './builtins'
import { type CommandContext, commands } from './registry'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>
let attentionInit: ReturnType<typeof useAttentionStore.getState>
let treeInit: ReturnType<typeof useFileTreeStore.getState>
let uiInit: ReturnType<typeof useUIStore.getState>

beforeAll(() => {
  registerBuiltinCommands()
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
  attentionInit = useAttentionStore.getState()
  treeInit = useFileTreeStore.getState()
  uiInit = useUIStore.getState()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useAttentionStore.setState(attentionInit, true)
  useFileTreeStore.setState(treeInit, true)
  useUIStore.setState(uiInit, true)
})

function seed(workDir = '/home/me/project'): string {
  useWorkspacesStore.setState({
    workspaces: [{ id: 's1', name: 'project', kind: 'terminal', workDir, state: 'idle' }],
    activeWorkspaceId: 's1',
  })
  useLayoutStore.getState().ensure('s1')
  return useLayoutStore.getState().byWorkspace.s1.activePaneId
}

function focusPane(paneId: string): void {
  const host = document.createElement('div')
  host.className = 'surface-host'
  host.dataset.paneId = paneId
  const input = document.createElement('textarea')
  host.append(input)
  document.body.append(host)
  input.focus()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
}

const fromPane = (paneId: string): CommandContext => ({
  activeWorkspaceId: 's1',
  activePaneId: paneId,
  target: { workspaceId: 's1', paneId },
  origin: 'remote',
})

const layout = () => useLayoutStore.getState().byWorkspace.s1
const editors = () => allPanes(layout().root).filter((p) => p.kind === 'editor')

describe('callerHasFocus', () => {
  it('is true for the human, and for a pane only while it is the focused pane of a focused window', () => {
    const paneId = seed()
    expect(callerHasFocus({ activePaneId: paneId })).toBe(true)
    expect(callerHasFocus(fromPane(paneId))).toBe(false)
    focusPane(paneId)
    expect(callerHasFocus(fromPane(paneId))).toBe(true)
    expect(callerHasFocus(fromPane('another-pane'))).toBe(false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(callerHasFocus(fromPane(paneId))).toBe(false)
  })

  it('opens quietly when asked to, whoever has focus', () => {
    const paneId = seed()
    focusPane(paneId)
    expect(opensQuietly(fromPane(paneId), undefined)).toBe(false)
    expect(opensQuietly(fromPane(paneId), true)).toBe(true)
    expect(opensQuietly(fromPane(paneId), 'yes')).toBe(false)
  })
})

describe('editor.openFiles from a pane', () => {
  it('takes focus when the calling pane has it', async () => {
    const caller = seed()
    focusPane(caller)
    await commands.execWith(fromPane(caller), OPEN_FILES_COMMAND, {
      files: [{ path: '/home/me/project/a.md' }],
    })
    expect(findPane(layout().root, layout().activePaneId)).toMatchObject({
      kind: 'editor',
      filePath: '/home/me/project/a.md',
    })
    expect(useAttentionStore.getState().byPane[layout().activePaneId]).toBeUndefined()
  })

  it('opens a background tab beside a caller without focus and marks it unread', async () => {
    const caller = seed()
    await commands.execWith(fromPane(caller), OPEN_FILES_COMMAND, {
      files: [{ path: '/home/me/project/a.md' }, { path: '/home/me/project/b.md' }],
    })
    expect(layout().activePaneId).toBe(caller)
    const opened = editors()
    expect(opened.map((p) => p.filePath)).toEqual([
      '/home/me/project/a.md',
      '/home/me/project/b.md',
    ])
    const stack = tabsOfPane(layout().root, caller)
    expect(stack?.activeId).toBe(caller)
    expect(stack?.children.map((tab) => tab.id)).toContain(opened[0].id)
    for (const pane of opened) {
      expect(tabMark(useAttentionStore.getState().byPane[pane.id])).toBe('unread')
    }
  })

  it('stays in the background with --background even when the caller has focus', async () => {
    const caller = seed()
    focusPane(caller)
    await commands.execWith(fromPane(caller), OPEN_FILES_COMMAND, {
      files: [{ path: '/home/me/project/a.md' }],
      background: true,
    })
    expect(layout().activePaneId).toBe(caller)
    expect(editors()).toHaveLength(1)
    expect(document.activeElement?.closest<HTMLElement>('.surface-host')?.dataset.paneId).toBe(
      caller,
    )
  })

  it('opens no second tab for a file already open, and does not switch to it quietly', async () => {
    const caller = seed()
    const args = { files: [{ path: '/home/me/project/a.md' }] }
    await commands.execWith(fromPane(caller), OPEN_FILES_COMMAND, args)
    await commands.execWith(fromPane(caller), OPEN_FILES_COMMAND, args)
    expect(editors()).toHaveLength(1)
    expect(layout().activePaneId).toBe(caller)
  })
})

describe('browser.new from a pane', () => {
  const browsers = () => allPanes(layout().root).filter((p) => p.kind === 'browser')

  it('opens a background tab on the isolated profile for a caller without focus', async () => {
    const caller = seed()
    await commands.execWith(fromPane(caller), 'browser.new', { url: 'https://example.com/' })
    expect(layout().activePaneId).toBe(caller)
    expect(browsers()).toMatchObject([{ url: 'https://example.com/' }])
    expect(paneBrowserProfile(browsers()[0])).toBe('isolated')
    expect(tabMark(useAttentionStore.getState().byPane[browsers()[0].id])).toBe('unread')
  })

  it('shows the browser when the calling pane has focus, still isolated', async () => {
    const caller = seed()
    focusPane(caller)
    await commands.execWith(fromPane(caller), 'browser.new', { url: 'https://example.com/' })
    const shown = findPane(layout().root, layout().activePaneId)
    expect(shown?.kind).toBe('browser')
    expect(shown && paneBrowserProfile(shown)).toBe('isolated')
  })
})

describe('files.reveal', () => {
  it('shows the Files panel on the folder without taking focus, and changes nothing for the folder already shown', async () => {
    const caller = seed()
    await commands.execWith(fromPane(caller), REVEAL_FOLDER_COMMAND, { path: '/home/me/project' })
    expect(useFileTreeStore.getState().shown).toBeNull()
    expect(useUIStore.getState().filesOpen).toBe(true)
    await commands.execWith(fromPane(caller), REVEAL_FOLDER_COMMAND, {
      path: '/home/me/project/src/lib',
    })
    expect(useFileTreeStore.getState().shown).toEqual({
      workspaceId: 's1',
      dir: '/home/me/project/src/lib',
      from: '/home/me/project',
    })
    expect(layout().activePaneId).toBe(caller)
  })

  it('makes the folder the tree’s root until the pane changes folder', async () => {
    const caller = seed()
    await commands.execWith(fromPane(caller), REVEAL_FOLDER_COMMAND, { path: '/home/me/other' })
    const shown = useFileTreeStore.getState().shown
    expect(shown).toEqual({ workspaceId: 's1', dir: '/home/me/other', from: '/home/me/project' })
    expect(treeRoot('s1', followedFolder('s1').cwd, shown)).toBe('/home/me/other')
    useLayoutStore.getState().setCwd('s1', caller, '/home/me/project/src')
    expect(treeRoot('s1', followedFolder('s1').cwd, shown)).toBe('/home/me/project/src')
    expect(treeRoot('s2', '/home/me/project', shown)).toBe('/home/me/project')
  })

  it('never moves the workspace’s folder', async () => {
    const caller = seed()
    await commands.execWith(fromPane(caller), REVEAL_FOLDER_COMMAND, { path: '/home/me/other' })
    expect(useWorkspacesStore.getState().workspaces[0].workDir).toBe('/home/me/project')
  })

  it('refuses anything that is not an absolute path', async () => {
    const caller = seed()
    const res = await commands.execWith(fromPane(caller), REVEAL_FOLDER_COMMAND, { path: 'src' })
    expect(res.ok).toBe(false)
    expect(useFileTreeStore.getState().shown).toBeNull()
  })
})
