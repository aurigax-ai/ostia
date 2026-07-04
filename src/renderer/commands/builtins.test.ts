import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { registerBuiltinCommands } from './builtins'
import { type CommandContext, commands } from './registry'

// `commands` is a module singleton and `register` throws on duplicate ids, so the
// built-ins must be registered exactly once for the whole file.
let sessionsInit: ReturnType<typeof useSessionsStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  registerBuiltinCommands()
  // Pristine store snapshots — the splitRight/splitDown cases seed the provider's
  // stores, so restore both (replace: true) after every test to prevent leakage.
  sessionsInit = useSessionsStore.getState()
  layoutInit = useLayoutStore.getState()
})

afterEach(() => {
  vi.restoreAllMocks()
  useSessionsStore.setState(sessionsInit, true)
  useLayoutStore.setState(layoutInit, true)
})

const ctx = (activeSessionId: string | null, activePaneId: string | null): CommandContext => ({
  activeSessionId,
  activePaneId,
})

describe('builtins declare targets', () => {
  it('non-pane commands are target:none, pane commands stay target:active', () => {
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))

    expect(byId['session.new'].target).toBe('none')
    expect(byId['palette.toggle'].target).toBe('none')
    expect(byId['view.toggleRail'].target).toBe('none')
    expect(byId['app.openSettings'].target).toBe('none')

    for (const id of [
      'pane.split',
      'pane.splitRight',
      'pane.splitDown',
      'pane.close',
      'pane.focus',
      'pane.move',
      'pane.remove',
    ]) {
      expect(byId[id].target).toBe('active')
    }
  })
})

describe('builtins route to store actions', () => {
  it('routes pane.split to layout.split with an explicit paneId', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.split', {
      paneId: 'pX',
      direction: 'horizontal',
    })

    expect(split).toHaveBeenCalledWith('s1', 'pX', 'horizontal')
  })

  it('falls back to the active pane when pane.split gets no paneId', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.split', { direction: 'horizontal' })

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'horizontal')
  })

  it('does not split when there is no active session', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.split', {
      paneId: 'pX',
      direction: 'horizontal',
    })

    expect(split).not.toHaveBeenCalled()
  })

  it('routes pane.splitRight to layout.split with a horizontal direction', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})
    // splitRight delegates via commands.exec, which resolves the active pane through
    // the context provider — so seed the provider's stores instead of passing a ctx.
    useSessionsStore.setState({ activeSessionId: 's1' })
    useLayoutStore.setState({
      bySession: { s1: { root: createPane('terminal'), activePaneId: 'pA' } },
    })

    await commands.exec('pane.splitRight')

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'horizontal')
  })

  it('routes pane.splitDown to layout.split with a vertical direction', async () => {
    const split = vi.spyOn(useLayoutStore.getState(), 'split').mockImplementation(() => {})
    useSessionsStore.setState({ activeSessionId: 's1' })
    useLayoutStore.setState({
      bySession: { s1: { root: createPane('terminal'), activePaneId: 'pA' } },
    })

    await commands.exec('pane.splitDown')

    expect(split).toHaveBeenCalledWith('s1', 'pA', 'vertical')
  })

  it('routes pane.close to layout.closePane with an explicit paneId', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.close', { paneId: 'pX' })

    expect(closePane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('falls back to the active pane when pane.close gets no paneId', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.close')

    expect(closePane).toHaveBeenCalledWith('s1', 'pA')
  })

  it('routes pane.focus to layout.focusPane', async () => {
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.focus', { paneId: 'pX' })

    expect(focusPane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('routes pane.move to layout.movePane with source, target, and zone', async () => {
    const movePane = vi.spyOn(useLayoutStore.getState(), 'movePane').mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.move', {
      sourceId: 'src',
      targetId: 'tgt',
      zone: 'right',
    })

    expect(movePane).toHaveBeenCalledWith('s1', 'src', 'tgt', 'right')
  })

  it('routes pane.remove to layout.removePane', async () => {
    const removePane = vi
      .spyOn(useLayoutStore.getState(), 'removePane')
      .mockImplementation(() => {})

    await commands.execWith(ctx('s1', 'pA'), 'pane.remove', { paneId: 'pX' })

    expect(removePane).toHaveBeenCalledWith('s1', 'pX')
  })

  it('does not close a pane when there is no active session', async () => {
    const closePane = vi.spyOn(useLayoutStore.getState(), 'closePane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.close', { paneId: 'pX' })

    expect(closePane).not.toHaveBeenCalled()
  })

  it('does not focus a pane when there is no active session', async () => {
    const focusPane = vi.spyOn(useLayoutStore.getState(), 'focusPane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.focus', { paneId: 'pX' })

    expect(focusPane).not.toHaveBeenCalled()
  })

  it('does not move a pane when there is no active session', async () => {
    const movePane = vi.spyOn(useLayoutStore.getState(), 'movePane').mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.move', {
      sourceId: 'src',
      targetId: 'tgt',
      zone: 'right',
    })

    expect(movePane).not.toHaveBeenCalled()
  })

  it('does not remove a pane when there is no active session', async () => {
    const removePane = vi
      .spyOn(useLayoutStore.getState(), 'removePane')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, 'pA'), 'pane.remove', { paneId: 'pX' })

    expect(removePane).not.toHaveBeenCalled()
  })

  it('routes session.new to leaveSettings then addSession, in that order', async () => {
    const leaveSettings = vi
      .spyOn(useUIStore.getState(), 'leaveSettings')
      .mockImplementation(() => {})
    const addSession = vi
      .spyOn(useSessionsStore.getState(), 'addSession')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'session.new')

    expect(leaveSettings).toHaveBeenCalled()
    expect(addSession).toHaveBeenCalled()
    // Leave Settings first so the new session isn't created hidden behind the Settings view.
    expect(leaveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      addSession.mock.invocationCallOrder[0],
    )
  })

  it('routes palette.toggle to ui.togglePalette', async () => {
    const togglePalette = vi
      .spyOn(useUIStore.getState(), 'togglePalette')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'palette.toggle')

    expect(togglePalette).toHaveBeenCalled()
  })

  it('routes view.toggleRail to ui.toggleRail', async () => {
    const toggleRail = vi.spyOn(useUIStore.getState(), 'toggleRail').mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'view.toggleRail')

    expect(toggleRail).toHaveBeenCalled()
  })

  it('routes app.openSettings to ui.openSettings', async () => {
    const openSettings = vi
      .spyOn(useUIStore.getState(), 'openSettings')
      .mockImplementation(() => {})

    await commands.execWith(ctx(null, null), 'app.openSettings')

    expect(openSettings).toHaveBeenCalled()
  })
})
