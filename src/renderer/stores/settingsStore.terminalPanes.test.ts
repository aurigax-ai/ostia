import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

const store = () => useSettingsStore.getState()

describe('settingsStore terminal and pane settings', () => {
  let initialState: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    initialState = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(window.pine.fs.write).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    useSettingsStore.setState(initialState, true)
  })

  it('starts with the documented defaults', () => {
    expect(store().terminal).toEqual({
      scrollSpeed: 1,
      scrollbackLines: 10000,
      warnOnRiskyPaste: true,
      minimumContrast: 1,
    })
    expect(store().panes).toEqual({
      dimInactive: true,
      focusOnHover: false,
      equalizeOnSplit: false,
      hideTabClose: false,
    })
  })

  it('validates both sections when settings.json loads', async () => {
    vi.mocked(window.pine.fs.read).mockResolvedValue(
      JSON.stringify({
        terminal: {
          scrollSpeed: 50,
          scrollbackLines: 12,
          minimumContrast: 'x',
          warnOnRiskyPaste: 0,
        },
        panes: { dimInactive: false, focusOnHover: 'yes' },
      }),
    )
    await store().init()
    expect(store().terminal).toEqual({
      scrollSpeed: 5,
      scrollbackLines: 1000,
      minimumContrast: 1,
      warnOnRiskyPaste: true,
    })
    expect(store().panes.dimInactive).toBe(false)
    expect(store().panes.focusOnHover).toBe(false)
  })

  it('clamps setTerminal and saves both sections', async () => {
    store().setTerminal({ scrollbackLines: 999999, minimumContrast: 4.5 })
    store().setPanes({ hideTabClose: true })
    expect(store().terminal.scrollbackLines).toBe(100000)
    await vi.runAllTimersAsync()
    const written = JSON.parse(String(vi.mocked(window.pine.fs.write).mock.calls.at(-1)?.[1]))
    expect(written.terminal.scrollbackLines).toBe(100000)
    expect(written.terminal.minimumContrast).toBe(4.5)
    expect(written.panes.hideTabClose).toBe(true)
  })

  it('clamps values set through the settings path used by the CLI', () => {
    store().setByPath('terminal.scrollbackLines', 5)
    expect(store().terminal.scrollbackLines).toBe(1000)
    store().setByPath('terminal.scrollSpeed', 2.5)
    expect(store().terminal.scrollSpeed).toBe(2.5)
    store().setByPath('panes.focusOnHover', true)
    expect(store().panes.focusOnHover).toBe(true)
  })
})
