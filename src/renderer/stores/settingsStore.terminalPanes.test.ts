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
    vi.mocked(window.ostia.fs.write).mockClear()
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
      clipboardKeys: 'shift',
      prompt: {
        style: 'shell',
        chips: ['conda', 'virtualenv', 'node', 'cwd', 'git.branch', 'git.diff-stats'],
        sameLine: false,
        separator: 'none',
      },
      theme: 'match',
      shell: '',
      osc52Write: false,
      keepShells: false,
      primarySelection: true,
      macOptionIsMeta: false,
      renderer: 'xterm',
    })
    expect(store().panes).toEqual({
      dimInactive: true,
      focusOnHover: false,
      equalizeOnSplit: false,
      hideTabClose: false,
    })
  })

  it('validates both sections when settings.json loads', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue(
      JSON.stringify({
        terminal: {
          scrollSpeed: 50,
          scrollbackLines: 12,
          minimumContrast: 'x',
          warnOnRiskyPaste: 0,
          prompt: { style: 'ostia', chips: ['cwd', 'nope', 'git.branch', 'cwd'], separator: '#' },
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
      prompt: { style: 'ostia', chips: ['cwd', 'git.branch'], sameLine: false, separator: 'none' },
      clipboardKeys: 'shift',
      theme: 'match',
      shell: '',
      osc52Write: false,
      keepShells: false,
      primarySelection: true,
      macOptionIsMeta: false,
      renderer: 'xterm',
    })
    expect(store().panes.dimInactive).toBe(false)
    expect(store().panes.focusOnHover).toBe(false)
  })

  it('clamps setTerminal and saves both sections', async () => {
    store().setTerminal({ scrollbackLines: 999999, minimumContrast: 4.5 })
    store().setPanes({ hideTabClose: true })
    expect(store().terminal.scrollbackLines).toBe(100000)
    await vi.runAllTimersAsync()
    const written = JSON.parse(String(vi.mocked(window.ostia.fs.write).mock.calls.at(-1)?.[1]))
    expect(written.terminal.scrollbackLines).toBe(100000)
    expect(written.terminal.minimumContrast).toBe(4.5)
    expect(written.panes.hideTabClose).toBe(true)
  })

  it('validates the prompt set through the settings path used by the CLI', () => {
    expect(() => store().setByPath('terminal.prompt.chips', ['time24', 'bogus', 'cwd'])).toThrow(
      'invalid value for terminal.prompt.chips',
    )
    store().setByPath('terminal.prompt.chips', ['time24', 'cwd'])
    store().setByPath('terminal.prompt.style', 'ostia')
    expect(store().terminal.prompt).toMatchObject({ style: 'ostia', chips: ['time24', 'cwd'] })
    store().setByPath('terminal.prompt.style', 'shell')
    expect(store().setByPath('terminal.prompt.style', 'ostia').value).toBe('ostia')
    expect(store().terminal.prompt.style).toBe('ostia')
    expect(() => store().setByPath('terminal.prompt.style', 'fancy')).toThrow(
      'invalid value for terminal.prompt.style',
    )
    expect(store().terminal.prompt.style).toBe('ostia')
  })

  it('refuses out-of-range values set through the settings path used by the CLI', () => {
    const before = store().terminal.scrollbackLines
    expect(() => store().setByPath('terminal.scrollbackLines', 5)).toThrow(
      'invalid value for terminal.scrollbackLines',
    )
    expect(store().terminal.scrollbackLines).toBe(before)
    store().setByPath('terminal.scrollSpeed', 2.5)
    expect(store().terminal.scrollSpeed).toBe(2.5)
    store().setByPath('panes.focusOnHover', true)
    expect(store().panes.focusOnHover).toBe(true)
  })
})
