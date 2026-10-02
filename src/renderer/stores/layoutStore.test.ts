import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { zhHant } from '../i18n/dict'
import { findPane, firstPaneId, paneIds, tabsOfPane } from '../layout/tree'
import type { SplitNode } from '../layout/types'
import { BASE_LANGUAGE } from '../lib/languagePacks'
import { useLayoutStore } from './layoutStore'
import { usePluginsStore } from './pluginsStore'
import { useSettingsStore } from './settingsStore'
import { useWorkspacesStore } from './workspacesStore'

const emit = () => vi.mocked(window.pine.lifecycle.emit)
const layoutOf = (sid: string) => useLayoutStore.getState().byWorkspace[sid]

function ensure(sid: string): string {
  useLayoutStore.getState().ensure(sid)
  return firstPaneId(layoutOf(sid).root)
}

function twoPanes(sid: string): { first: string; second: string } {
  const first = ensure(sid)
  useLayoutStore.getState().split(sid, first, 'horizontal')
  const ids = paneIds(layoutOf(sid).root)
  const second = ids.find((id) => id !== first) as string
  return { first, second }
}

describe('layoutStore', () => {
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>
  let pluginsInit: ReturnType<typeof usePluginsStore.getState>

  beforeAll(() => {
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    settingsInit = useSettingsStore.getState()
    pluginsInit = usePluginsStore.getState()
  })

  beforeEach(() => {
    emit().mockClear()
  })

  afterEach(() => {
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useSettingsStore.setState(settingsInit, true)
    usePluginsStore.setState(pluginsInit, true)
    vi.restoreAllMocks()
  })

  it('starts with an empty byWorkspace', () => {
    expect(useLayoutStore.getState().byWorkspace).toEqual({})
  })

  describe('ensure', () => {
    it('creates a one-terminal-pane layout and emits pane-created for it', () => {
      const paneId = ensure('sess')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([paneId])
      expect(findPane(layout.root, paneId)?.kind).toBe('terminal')
      expect(layout.activePaneId).toBe(paneId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({ type: 'pane-created', workspaceId: 'sess', paneId })
    })

    it('reads the workspace workDir from useWorkspacesStore into the new pane cwd', () => {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/me/proj', state: 'idle' },
        ],
        activeWorkspaceId: 'w1',
      })

      const paneId = ensure('w1')
      expect(findPane(layoutOf('w1').root, paneId)?.cwd).toBe('/home/me/proj')
    })

    it('is a no-op on a second call (layout unchanged, no second emit)', () => {
      ensure('sess')
      const before = layoutOf('sess')
      emit().mockClear()

      useLayoutStore.getState().ensure('sess')

      expect(layoutOf('sess')).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('default terminal title', () => {
    it('gives every new terminal the neutral word and marks it untouched', () => {
      const first = ensure('sess')
      useLayoutStore.getState().split('sess', first, 'horizontal')
      useLayoutStore.getState().newTab('sess', first, 'terminal')

      const panes = paneIds(layoutOf('sess').root).map((id) => findPane(layoutOf('sess').root, id))
      expect(panes).toHaveLength(3)
      for (const pane of panes)
        expect(pane).toMatchObject({ title: 'Terminal', defaultTitle: true })
    })

    it('names an untouched tab after its shell and leaves a titled one alone', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().setTitle('sess', second, '✳ Fix the build')

      useLayoutStore.getState().setDefaultTitle('sess', first, 'bash')
      useLayoutStore.getState().setDefaultTitle('sess', second, 'bash')

      expect(findPane(layoutOf('sess').root, first)).toMatchObject({
        title: 'bash',
        defaultTitle: true,
      })
      expect(findPane(layoutOf('sess').root, second)?.title).toBe('✳ Fix the build')
    })

    it('drops the shell name of an untouched tab once its shell is stopped to hibernate', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().setDefaultTitle('sess', first, 'bash')
      useLayoutStore.getState().setTitle('sess', second, '✳ Fix the build')

      useLayoutStore.getState().setHibernated('sess', first, true)
      useLayoutStore.getState().setHibernated('sess', second, true)

      expect(findPane(layoutOf('sess').root, first)).toMatchObject({
        title: 'Terminal',
        hibernated: true,
      })
      expect(findPane(layoutOf('sess').root, second)?.title).toBe('✳ Fix the build')
    })

    it('does not mark a tab opened with a title, a browser tab or an editor', () => {
      const first = ensure('sess')
      const named = useLayoutStore.getState().openTerminal('sess', { title: 'pnpm dev' }) as string
      const browser = useLayoutStore.getState().newTab('sess', first, 'browser') as string

      expect(findPane(layoutOf('sess').root, named)).not.toHaveProperty('defaultTitle')
      expect(findPane(layoutOf('sess').root, browser)).not.toHaveProperty('defaultTitle')
    })
  })

  describe('split', () => {
    it('adds a pane, focuses the new pane, and emits pane-created for it', () => {
      const first = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().split('sess', first, 'horizontal')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const newId = ids.find((id) => id !== first) as string

      expect(ids).toHaveLength(2)
      expect(layout.activePaneId).toBe(newId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        workspaceId: 'sess',
        paneId: newId,
      })
    })

    it('is a no-op on an absent workspace (no emit)', () => {
      const before = useLayoutStore.getState().byWorkspace

      useLayoutStore.getState().split('ghost', 'pane-x', 'horizontal')

      expect(useLayoutStore.getState().byWorkspace).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })

    it('on an existing workspace with a missing target pane, adds no pane and does not emit', () => {
      const paneId = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().split('sess', 'nonexistent-pane', 'horizontal')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([paneId])
      expect(layout.activePaneId).toBe(paneId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('locked panes', () => {
    it('keeps a locked pane through closePane and closes it once unlocked', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().setLocked('sess', second, true)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)

      expect(paneIds(layoutOf('sess').root)).toEqual([first, second])
      expect(useLayoutStore.getState().isLocked('sess')).toBe(true)
      expect(useLayoutStore.getState().isLocked('sess', first)).toBe(false)
      expect(emit()).not.toHaveBeenCalled()

      useLayoutStore.getState().setLocked('sess', second, false)
      useLayoutStore.getState().closePane('sess', second)

      expect(paneIds(layoutOf('sess').root)).toEqual([first])
    })

    it('keeps the only pane of a workspace when it is locked', () => {
      const only = ensure('sess')
      useLayoutStore.getState().setLocked('sess', only, true)

      useLayoutStore.getState().closePane('sess', only)

      expect(layoutOf('sess').root).toMatchObject({ id: only, locked: true })
    })
  })

  describe('closePane (conditional pane-closed emit)', () => {
    it('removes a real pane in a 2-pane layout, moves focus, and emits pane-closed once', () => {
      const { first, second } = twoPanes('sess')
      expect(layoutOf('sess').activePaneId).toBe(second)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([first])
      expect(findPane(layout.root, second)).toBeNull()
      expect(layout.activePaneId).toBe(first)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        workspaceId: 'sess',
        paneId: second,
      })
    })

    it('closing the last pane leaves the workspace empty and announces the pane', () => {
      const only = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', only)

      expect(layoutOf('sess')).toBeUndefined()
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        workspaceId: 'sess',
        paneId: only,
      })
    })

    it('emits no pane-closed for an id that never existed or was already closed', () => {
      const { second } = twoPanes('sess')
      useLayoutStore.getState().closePane('sess', second)
      emit().mockClear()

      useLayoutStore.getState().closePane('sess', second)
      useLayoutStore.getState().closePane('sess', 'pane-bogus')

      expect(emit()).not.toHaveBeenCalled()
    })

    it('is a no-op on an absent workspace (no emit)', () => {
      const before = useLayoutStore.getState().byWorkspace

      useLayoutStore.getState().closePane('ghost', 'pane-x')

      expect(useLayoutStore.getState().byWorkspace).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('focusPane', () => {
    it('sets activePaneId and emits no lifecycle event', () => {
      const { first, second } = twoPanes('sess')
      expect(layoutOf('sess').activePaneId).toBe(second)
      emit().mockClear()

      useLayoutStore.getState().focusPane('sess', first)

      expect(layoutOf('sess').activePaneId).toBe(first)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('resize', () => {
    it("updates the target split's sizes and emits no lifecycle event", () => {
      twoPanes('sess')
      const root = layoutOf('sess').root as SplitNode
      expect(root.type).toBe('split')
      emit().mockClear()

      useLayoutStore.getState().resize('sess', root.id, [3, 1])

      expect((layoutOf('sess').root as SplitNode).sizes).toEqual([3, 1])
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('movePane', () => {
    it('relocates the pane, sets activePaneId = source, and emits no lifecycle event', () => {
      const { first, second } = twoPanes('sess')
      emit().mockClear()
      useLayoutStore.getState().movePane('sess', second, first, 'top')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toEqual([second, first])
      expect((layout.root as SplitNode).direction).toBe('vertical')
      expect(layout.activePaneId).toBe(second)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('setCwd', () => {
    it("updates the target pane's cwd and emits no lifecycle event", () => {
      const paneId = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().setCwd('sess', paneId, '/x')

      expect(findPane(layoutOf('sess').root, paneId)?.cwd).toBe('/x')
      expect(emit()).not.toHaveBeenCalled()
    })

    it('leaves the store state identical when the cwd is unchanged', () => {
      const paneId = ensure('sess')
      useLayoutStore.getState().setCwd('sess', paneId, '/x')
      const before = useLayoutStore.getState().byWorkspace

      useLayoutStore.getState().setCwd('sess', paneId, '/x')

      expect(useLayoutStore.getState().byWorkspace).toBe(before)
    })
  })

  describe('setUrl', () => {
    it("records the browser pane's url and is a no-op when unchanged", () => {
      ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://a.test/', 'isolated')
      const paneId = layoutOf('sess').activePaneId

      useLayoutStore.getState().setUrl('sess', paneId, 'https://a.test/next')
      expect(findPane(layoutOf('sess').root, paneId)?.url).toBe('https://a.test/next')

      const before = useLayoutStore.getState().byWorkspace
      useLayoutStore.getState().setUrl('sess', paneId, 'https://a.test/next')
      expect(useLayoutStore.getState().byWorkspace).toBe(before)
    })
  })

  describe('openFile', () => {
    const openIn = (openFilesIn: 'tab' | 'split') =>
      useSettingsStore.setState((s) => ({ editor: { ...s.editor, openFilesIn } }))
    afterEach(() => openIn('tab'))

    it('in tab mode, opens the file as a tab of the focused pane', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openFile('sess', '/a/b/foo.ts')
      const layout = layoutOf('sess')
      const editorId = paneIds(layout.root).find((id) => id !== terminal) as string

      expect(layout.root.type).toBe('tabs')
      expect(findPane(layout.root, editorId)).toMatchObject({
        kind: 'editor',
        filePath: '/a/b/foo.ts',
      })
      expect(layout.activePaneId).toBe(editorId)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        workspaceId: 'sess',
        paneId: editorId,
      })
    })

    it('in tab mode, reuses the editor tab of the focused slot and focuses a file already open', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().focusPane('sess', first)
      useLayoutStore.getState().openFile('sess', '/a/foo.ts')
      const editorId = layoutOf('sess').activePaneId
      useLayoutStore.getState().focusPane('sess', first)

      useLayoutStore.getState().openFile('sess', '/a/bar.ts')
      expect(layoutOf('sess').activePaneId).toBe(editorId)
      expect(findPane(layoutOf('sess').root, editorId)?.filePath).toBe('/a/bar.ts')
      expect(paneIds(layoutOf('sess').root)).toHaveLength(3)

      useLayoutStore.getState().focusPane('sess', second)
      useLayoutStore.getState().openFile('sess', '/a/bar.ts')
      expect(layoutOf('sess').activePaneId).toBe(editorId)
      expect(paneIds(layoutOf('sess').root)).toHaveLength(3)
    })

    it('with no editor pane, splits and creates an editor pane, emitting pane-created', () => {
      openIn('split')
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openFile('sess', '/a/b/foo.ts')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const editorId = ids.find((id) => id !== terminal) as string
      const editor = findPane(layout.root, editorId)

      expect(ids).toHaveLength(2)
      expect(layout.root.type).toBe('split')
      expect(editor?.kind).toBe('editor')
      expect(editor?.filePath).toBe('/a/b/foo.ts')
      expect(editor?.title).toBe('foo.ts')
      expect(layout.activePaneId).toBe(editorId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        workspaceId: 'sess',
        paneId: editorId,
      })
    })

    it('with an existing editor pane, reuses it (no new pane, no pane-created emit)', () => {
      openIn('split')
      const terminal = ensure('sess')
      useLayoutStore.getState().openFile('sess', '/a/b/foo.ts')
      const editorId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      emit().mockClear()

      useLayoutStore.getState().openFile('sess', '/c/d/bar.ts')
      const layout = layoutOf('sess')
      const reused = findPane(layout.root, editorId)

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(reused?.kind).toBe('editor')
      expect(reused?.filePath).toBe('/c/d/bar.ts')
      expect(reused?.title).toBe('bar.ts')
      expect(layout.activePaneId).toBe(editorId)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('openFileTab', () => {
    it('adds every file as its own tab after the named pane and focuses the last', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().focusPane('sess', first)
      emit().mockClear()

      useLayoutStore.getState().openFileTab('sess', '/tmp/a.txt', second)
      useLayoutStore.getState().openFileTab('sess', '/tmp/b.png')

      const stack = tabsOfPane(layoutOf('sess').root, second)
      expect(stack?.children.map((p) => p.filePath)).toEqual([
        undefined,
        '/tmp/a.txt',
        '/tmp/b.png',
      ])
      expect(findPane(layoutOf('sess').root, layoutOf('sess').activePaneId)?.filePath).toBe(
        '/tmp/b.png',
      )
      expect(tabsOfPane(layoutOf('sess').root, first)).toBeNull()
      expect(emit()).toHaveBeenCalledTimes(2)
    })

    it('focuses the tab already showing the file instead of opening it twice', () => {
      const first = ensure('sess')
      useLayoutStore.getState().openFileTab('sess', '/tmp/a.txt')
      const editorId = layoutOf('sess').activePaneId
      useLayoutStore.getState().focusPane('sess', first)
      emit().mockClear()

      useLayoutStore.getState().openFileTab('sess', '/tmp/a.txt')

      expect(layoutOf('sess').activePaneId).toBe(editorId)
      expect(paneIds(layoutOf('sess').root)).toHaveLength(2)
      expect(emit()).not.toHaveBeenCalled()
    })

    it('falls back to the active pane when the named pane is gone, and seeds an empty workspace', () => {
      const first = ensure('sess')
      useLayoutStore.getState().openFileTab('sess', '/tmp/a.txt', 'gone')
      expect(tabsOfPane(layoutOf('sess').root, first)?.children).toHaveLength(2)

      useWorkspacesStore.setState({
        workspaces: [{ id: 'w9', name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
      })
      useLayoutStore.getState().openFileTab('w9', '/tmp/b.png')
      expect(layoutOf('w9').root).toMatchObject({ kind: 'editor', filePath: '/tmp/b.png' })
    })
  })

  describe('openDiff', () => {
    it('adds the diff as a tab of the focused pane in a split, not a new split', () => {
      const { first, second } = twoPanes('sess')
      useLayoutStore.getState().focusPane('sess', first)
      const diffId = useLayoutStore
        .getState()
        .openDiff('sess', { title: 'a.ts', original: 'a', modified: 'b' } as never) as string
      const layout = layoutOf('sess')
      expect(layout.root.type).toBe('split')
      expect(paneIds(layout.root)).toHaveLength(3)
      expect(findPane(layout.root, diffId)?.kind).toBe('diff')
      expect(layout.activePaneId).toBe(diffId)
      expect(findPane(layout.root, second)).not.toBeNull()
      const stacks = layout.root.type === 'split' ? layout.root.children : []
      const stack = stacks.find((c) => c.type === 'tabs')
      expect(stack && paneIds(stack)).toEqual([first, diffId])
    })
  })

  describe('openBrowser', () => {
    it('with no browser pane, adds a browser tab beside the focused pane, emitting pane-created', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openBrowser('sess', 'https://example.com/path', 'isolated')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const browserId = ids.find((id) => id !== terminal) as string
      const browser = findPane(layout.root, browserId)

      expect(ids).toHaveLength(2)
      expect(layout.root.type).toBe('tabs')
      expect(browser?.kind).toBe('browser')
      expect(browser?.url).toBe('https://example.com/path')
      expect(browser?.title).toBe('example.com')
      expect(layout.activePaneId).toBe(browserId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        workspaceId: 'sess',
        paneId: browserId,
      })
    })

    it('with an existing browser pane, reuses it (no new pane, no pane-created emit)', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://example.com', 'isolated')
      const browserId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      emit().mockClear()

      useLayoutStore.getState().openBrowser('sess', 'https://other.example', 'isolated')
      const layout = layoutOf('sess')
      const reused = findPane(layout.root, browserId)

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(reused?.kind).toBe('browser')
      expect(reused?.url).toBe('https://other.example')
      expect(reused?.title).toBe('other.example')
      expect(layout.activePaneId).toBe(browserId)
      expect(emit()).not.toHaveBeenCalled()
    })

    it('records the shared profile on a pane opened with it', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://example.com', 'shared')
      const browserId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      expect(findPane(layoutOf('sess').root, browserId)?.browserProfile).toBe('shared')
    })

    it('never reuses a pane of the other profile', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://mine.example', 'shared')
      useLayoutStore.getState().openBrowser('sess', 'https://agent.example', 'isolated')
      const panes = paneIds(layoutOf('sess').root)
        .filter((id) => id !== terminal)
        .map((id) => findPane(layoutOf('sess').root, id))
      expect(panes).toHaveLength(2)
      expect(panes.find((p) => p?.browserProfile === 'shared')?.url).toBe('https://mine.example')
      expect(panes.find((p) => p?.browserProfile !== 'shared')?.url).toBe('https://agent.example')

      useLayoutStore.getState().openBrowser('sess', 'https://mine2.example', 'shared')
      const shared = paneIds(layoutOf('sess').root)
        .map((id) => findPane(layoutOf('sess').root, id))
        .filter((p) => p?.browserProfile === 'shared')
      expect(shared).toHaveLength(1)
      expect(shared[0]?.url).toBe('https://mine2.example')
    })

    it('keeps a pane’s profile when it navigates', () => {
      ensure('sess')
      useLayoutStore.getState().openBrowser('sess', 'https://a.example', 'shared')
      const id = layoutOf('sess').activePaneId
      useLayoutStore.getState().openBrowser('sess', 'https://b.example', 'shared')
      expect(findPane(layoutOf('sess').root, id)).toMatchObject({
        url: 'https://b.example',
        browserProfile: 'shared',
      })
    })
  })

  describe('openExtensionPanel', () => {
    it('with no panel of that extension, splits and creates one, emitting pane-created', () => {
      const terminal = ensure('sess')
      emit().mockClear()

      useLayoutStore.getState().openExtensionPanel('sess', 'demo', 'Board')
      const layout = layoutOf('sess')
      const ids = paneIds(layout.root)
      const demoId = ids.find((id) => id !== terminal) as string
      const demo = findPane(layout.root, demoId)

      expect(ids).toHaveLength(2)
      expect(demo?.kind).toBe('extension')
      expect(demo?.extensionId).toBe('demo')
      expect(demo?.title).toBe('Board')
      expect(layout.activePaneId).toBe(demoId)
      expect(emit()).toHaveBeenCalledTimes(1)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-created',
        workspaceId: 'sess',
        paneId: demoId,
      })
    })

    it('with an existing panel of that extension, reuses it (no new pane, no emit)', () => {
      const terminal = ensure('sess')
      useLayoutStore.getState().openExtensionPanel('sess', 'notes', 'Notes')
      const notesId = paneIds(layoutOf('sess').root).find((id) => id !== terminal) as string
      useLayoutStore.getState().focusPane('sess', terminal)
      emit().mockClear()

      useLayoutStore.getState().openExtensionPanel('sess', 'notes', 'Notes')
      const layout = layoutOf('sess')

      expect(paneIds(layout.root)).toHaveLength(2)
      expect(layout.activePaneId).toBe(notesId)
      expect(emit()).not.toHaveBeenCalled()
    })

    it("opens a second extension's panel beside the first instead of reusing it", () => {
      ensure('sess')
      useLayoutStore.getState().openExtensionPanel('sess', 'notes', 'Notes')
      useLayoutStore.getState().openExtensionPanel('sess', 'demo', 'Board')
      const panes = paneIds(layoutOf('sess').root).map((id) => findPane(layoutOf('sess').root, id))

      expect(
        panes
          .map((p) => p?.extensionId)
          .filter(Boolean)
          .sort(),
      ).toEqual(['demo', 'notes'])
    })
  })

  describe('removeWorkspace', () => {
    it('drops the layout and emits pane-closed for each pane it held', () => {
      const { first, second } = twoPanes('sess')
      emit().mockClear()

      useLayoutStore.getState().removeWorkspace('sess')

      expect(layoutOf('sess')).toBeUndefined()
      expect('sess' in useLayoutStore.getState().byWorkspace).toBe(false)
      expect(emit()).toHaveBeenCalledTimes(2)
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        workspaceId: 'sess',
        paneId: first,
      })
      expect(emit()).toHaveBeenCalledWith({
        type: 'pane-closed',
        workspaceId: 'sess',
        paneId: second,
      })
    })

    it('is a no-op on an absent workspace (no emit)', () => {
      const before = useLayoutStore.getState().byWorkspace

      useLayoutStore.getState().removeWorkspace('ghost')

      expect(useLayoutStore.getState().byWorkspace).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('absent-workspace guard', () => {
    it('leaves state untouched and emits nothing for actions on an unknown workspace', () => {
      const before = useLayoutStore.getState().byWorkspace

      const store = useLayoutStore.getState()
      store.split('ghost', 'p', 'horizontal')
      store.closePane('ghost', 'p')
      store.focusPane('ghost', 'p')
      store.resize('ghost', 'sp', [1, 1])
      store.movePane('ghost', 'a', 'b', 'center')
      store.setCwd('ghost', 'p', '/x')
      store.openFile('ghost', '/f')
      store.openBrowser('ghost', 'https://x', 'isolated')
      store.openExtensionPanel('ghost', 'demo', 'Board')

      expect(useLayoutStore.getState().byWorkspace).toBe(before)
      expect(emit()).not.toHaveBeenCalled()
    })
  })

  describe('hydrate', () => {
    const pane = (id: string) => ({
      type: 'pane' as const,
      id,
      title: 'zsh',
      kind: 'terminal' as const,
    })

    it('installs a restored layout for each workspace', () => {
      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      expect(layoutOf('s40')).toEqual({
        root: pane('pane-40'),
        activePaneId: 'pane-40',
        zoomedPaneId: null,
      })
    })

    it('shows the neutral word on a restored tab that still had its default title', () => {
      const untouched = { ...pane('pane-1'), title: 'bash', defaultTitle: true as const }
      const hibernated = {
        ...pane('pane-2'),
        title: 'fish',
        defaultTitle: true as const,
        hibernated: true as const,
        resume: { agent: 'claude' as const, id: 'abc-1' },
      }
      const named = { ...pane('pane-3'), title: '✳ Fix the build' }
      useLayoutStore.getState().hydrate({
        s40: {
          root: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            children: [untouched, hibernated, named],
            sizes: [1, 1, 1],
          },
          activePaneId: 'pane-1',
          zoomedPaneId: null,
        },
      })

      const root = layoutOf('s40').root
      expect(findPane(root, 'pane-1')).toMatchObject({ title: 'Terminal', defaultTitle: true })
      expect(findPane(root, 'pane-2')).toMatchObject({ title: 'Terminal', hibernated: true })
      expect(findPane(root, 'pane-3')?.title).toBe('✳ Fix the build')
    })

    it('restores the default title in the language the human reads', () => {
      const zh = { id: 'zh-Hant', label: '繁體中文', catalog: zhHant }
      usePluginsStore.setState({ languages: [BASE_LANGUAGE, zh] })
      useSettingsStore.setState({ locale: 'zh-Hant' })
      const untouched = { ...pane('pane-1'), title: 'bash', defaultTitle: true as const }
      useLayoutStore.getState().hydrate({
        s40: { root: untouched, activePaneId: 'pane-1', zoomedPaneId: null },
      })

      expect(layoutOf('s40').root).toMatchObject({ title: '終端機', defaultTitle: true })
      const fresh = ensure('s41')
      expect(findPane(layoutOf('s41').root, fresh)).toMatchObject({
        title: '終端機',
        defaultTitle: true,
      })
    })

    it('replaces any layouts already built, rather than merging into them', () => {
      ensure('stale')

      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      expect(Object.keys(useLayoutStore.getState().byWorkspace)).toEqual(['s40'])
    })

    it('announces every restored pane so main can mint its identity', () => {
      useLayoutStore.getState().hydrate({
        s40: {
          root: {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            children: [pane('pane-1'), pane('pane-2')],
            sizes: [1, 1],
          },
          activePaneId: 'pane-1',
          zoomedPaneId: null,
        },
      })

      const emitted = emit().mock.calls.map((c) => c[0])
      expect(emitted).toContainEqual({ type: 'pane-created', workspaceId: 's40', paneId: 'pane-1' })
      expect(emitted).toContainEqual({ type: 'pane-created', workspaceId: 's40', paneId: 'pane-2' })
    })

    it('leaves ensure a no-op afterwards, so the first render cannot overwrite a restore', () => {
      useLayoutStore.getState().hydrate({
        s40: { root: pane('pane-40'), activePaneId: 'pane-40', zoomedPaneId: null },
      })

      useLayoutStore.getState().ensure('s40')

      expect(paneIds(layoutOf('s40').root)).toEqual(['pane-40'])
    })
  })

  describe('tabs', () => {
    it('opens a terminal tab in the workspace folder, not where the neighbouring tab went', () => {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 's1', name: 'app', kind: 'terminal', workDir: '/work/app', state: 'idle' },
        ],
      })
      const first = ensure('s1')
      useLayoutStore.getState().setCwd('s1', first, '/tmp/elsewhere')
      const id = useLayoutStore.getState().newTab('s1', first, 'terminal') as string

      expect(layoutOf('s1').activePaneId).toBe(id)
      expect(layoutOf('s1').root).toMatchObject({ type: 'tabs', activeId: id })
      expect(findPane(layoutOf('s1').root, id)?.cwd).toBe('/work/app')
      expect(emit()).toHaveBeenCalledWith({ type: 'pane-created', workspaceId: 's1', paneId: id })
    })

    it('starts a split terminal in the workspace folder', () => {
      useWorkspacesStore.setState({
        workspaces: [
          { id: 's1', name: 'app', kind: 'terminal', workDir: '/work/app', state: 'idle' },
        ],
      })
      const first = ensure('s1')
      useLayoutStore.getState().setCwd('s1', first, '/tmp/elsewhere')
      useLayoutStore.getState().split('s1', first, 'horizontal')

      const created = layoutOf('s1').activePaneId
      expect(created).not.toBe(first)
      expect(findPane(layoutOf('s1').root, created)?.cwd).toBe('/work/app')
    })

    it('opens a browser tab on a blank page', () => {
      const first = ensure('s1')
      const id = useLayoutStore.getState().newTab('s1', first, 'browser') as string
      expect(findPane(layoutOf('s1').root, id)).toMatchObject({
        kind: 'browser',
        url: 'about:blank',
      })
    })

    it('shows the tab of a pane that gets focused', () => {
      const first = ensure('s1')
      useLayoutStore.getState().newTab('s1', first, 'terminal')
      useLayoutStore.getState().focusPane('s1', first)
      expect(layoutOf('s1').root).toMatchObject({ type: 'tabs', activeId: first })
    })

    it('focuses a neighbouring tab, not another pane, when the focused tab closes', () => {
      const { first, second } = twoPanes('s1')
      const tab = useLayoutStore.getState().newTab('s1', second, 'terminal') as string
      useLayoutStore.getState().closePane('s1', tab)
      expect(layoutOf('s1').activePaneId).toBe(second)
      expect(first).not.toBe(second)
    })

    it('keeps an agent resume token on the pane', () => {
      const first = ensure('s1')
      useLayoutStore.getState().setResume('s1', first, { agent: 'codex', id: 'th_1' })
      const before = layoutOf('s1')
      useLayoutStore.getState().setResume('s1', first, { agent: 'codex', id: 'th_1' })
      expect(layoutOf('s1')).toBe(before)
      expect(findPane(layoutOf('s1').root, first)?.resume).toEqual({ agent: 'codex', id: 'th_1' })
    })
  })

  describe('empty workspace', () => {
    const seedWorkspace = (id: string) =>
      useWorkspacesStore.setState({
        workspaces: [{ id, name: 'w', kind: 'terminal', workDir: '/w', state: 'idle' }],
      })

    it('makes an opened file the first pane of an empty workspace', () => {
      seedWorkspace('w9')
      useLayoutStore.getState().openFile('w9', '/w/notes.md')
      expect(layoutOf('w9').root).toMatchObject({
        type: 'pane',
        kind: 'editor',
        filePath: '/w/notes.md',
      })
      expect(emit()).toHaveBeenCalledWith(expect.objectContaining({ type: 'pane-created' }))
    })

    it('makes a browser the first pane of an empty workspace', () => {
      seedWorkspace('w9')
      useLayoutStore.getState().openBrowser('w9', 'about:blank', 'isolated')
      expect(layoutOf('w9').root).toMatchObject({ kind: 'browser', url: 'about:blank' })
    })
  })
})
