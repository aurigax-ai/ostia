import { chords } from '../chords'
import { freshDataHome, seedSettings } from '../dataHome'
import {
  newTerminalWorkspace,
  openWorkspace,
  quitApp,
  runInTerminal,
  shownTerminal,
} from '../helpers'
import { expect, test } from '../test'
import { launchPlain, measure, PROMPT_TEXT, SHOWN_INPUT, shownRows } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

const SHOWN_ROWS = '.pane-slot:not([data-hidden]) .terminal-text'
const SETTINGS = { behavior: { gpuAcceleration: false }, workspaces: { confirmQuit: false } }

test('bench panes: new tab and split to prompt', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    for (let i = 0; i < RUNS + WARMUP; i++) {
      const tabs = await win.locator('.pane-tab').count()
      const tab = await measure(win, {
        start: { type: 'keydown', key: 't' },
        ends: {
          shown: [{ sel: '.pane-tab', min: tabs + 1 }],
          prompt: [{ sel: '.pane-tab', min: tabs + 1 }, shownRows(PROMPT_TEXT)],
          focus: [{ sel: '.pane-tab', min: tabs + 1 }, SHOWN_INPUT],
        },
        act: () => win.keyboard.press(chords.newTab),
      })
      await win.keyboard.press(chords.closePane)
      await expect(win.locator('.pane-tab')).toHaveCount(tabs, { timeout: 15_000 })
      const split = await measure(win, {
        start: { type: 'keydown', key: '\\' },
        ends: { prompt: [shownRows(PROMPT_TEXT, 2)] },
        act: () => win.keyboard.press(chords.splitRight),
      })
      await win.keyboard.press(chords.closePane)
      await expect(win.locator('.ghostty-host')).toHaveCount(tabs, { timeout: 15_000 })
      if (i < WARMUP) continue
      samples.add('tab.new-shown', tab.shown)
      samples.add('tab.new-prompt', tab.prompt)
      samples.add('tab.new-focus', tab.focus)
      samples.add('split.prompt', split.prompt)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})

test('bench panes: workspace switch to painted and focused', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'echo marker-one', shownTerminal(win))
    await newTerminalWorkspace(win)
    await runInTerminal(win, 'echo marker-two', shownTerminal(win))
    await expect(win.locator(SHOWN_ROWS).first()).toContainText('marker-two')
    const targets = [
      { key: '1', chord: 'Control+1', marker: 'marker-one' },
      { key: '2', chord: 'Control+2', marker: 'marker-two' },
    ]
    for (let i = 0; i < (RUNS + WARMUP) * 2; i++) {
      const target = targets[i % 2]
      const got = await measure(win, {
        start: { type: 'keydown', key: target.key },
        ends: {
          painted: [shownRows(target.marker)],
          focus: [shownRows(target.marker), SHOWN_INPUT],
        },
        act: () => win.keyboard.press(target.chord),
      })
      await win.waitForTimeout(150)
      if (i < WARMUP * 2) continue
      samples.add('workspace.switch-painted', got.painted)
      samples.add('workspace.switch-focus', got.focus)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})
