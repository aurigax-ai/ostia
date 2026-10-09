import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chords, isMac } from './chords'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import { openWorkspace, runInTerminal } from './helpers'
import { _electron as electron, expect, test } from './test'

async function launch(settings: object, inProjectFolder = false) {
  const dataHome = freshDataHome()
  const project = join(testHome(dataHome), 'project')
  mkdirSync(project, { recursive: true })
  const workspaces = inProjectFolder
    ? { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project }
    : DOM_RENDERER_SETTINGS.workspaces
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, workspaces, ...settings })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

test('OSC 52 sets the clipboard only while terminal.osc52Write is on', async () => {
  const { app, win } = await launch({ terminal: { osc52Write: true } })
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await runInTerminal(win, 'printf \'\\033]52;c;%s\\a\' "$(printf ostia-osc52 | base64)"')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe('ostia-osc52')
    await runInTerminal(win, "printf '\\033]52;c;?\\a'")
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('ostia-osc52')
  } finally {
    await app.close()
  }
})

test('selecting terminal text fills the primary selection, and middle click pastes it unless turned off', async () => {
  test.skip(isMac, 'the primary selection is X11 only')
  const { app, win } = await launch({})
  try {
    await runInTerminal(win, 'echo ostia-primary-word')
    const rows = win.locator('.xterm-rows').first()
    const line = rows.locator('div', { hasText: /^ostia-primary-word\s*$/ }).first()
    await expect(line).toBeAttached({ timeout: 15_000 })
    const box = await line.boundingBox()
    if (!box) throw new Error('no line box')
    await win.mouse.move(box.x + 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 })
    await win.mouse.up()
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.selection.readText()))
      .toContain('ostia')
    await expect(async () => {
      await app.evaluate(({ clipboard }) => clipboard.selection.writeText('echo from-primary'))
      await win.locator('.xterm').first().click({ button: 'middle' })
      await expect(rows).toContainText('echo from-primary', { timeout: 1000 })
    }).toPass({ timeout: 15_000 })
  } finally {
    await app.close()
  }

  const off = await launch({ terminal: { primarySelection: false } })
  try {
    await off.app.evaluate(({ clipboard }) => clipboard.selection.writeText('echo from-primary'))
    await off.win.locator('.xterm').first().click()
    await off.win.locator('.xterm').first().click({ button: 'middle' })
    await off.win.waitForTimeout(500)
    await expect(off.win.locator('.xterm-rows').first()).not.toContainText('from-primary')
  } finally {
    await off.app.close()
  }
})

test(
  'default chords split a pane, move focus by direction and zoom it',
  { tag: '@core' },
  async () => {
    const { app, win } = await launch({})
    try {
      await win.locator('.xterm').first().click()
      const panes = win.locator('.pane')
      await expect(panes).toHaveCount(1)
      const first = await panes.first().getAttribute('data-pane-id')

      await win.keyboard.press(chords.splitRight)
      await expect(panes).toHaveCount(2)
      const active = win.locator('.pane.active')
      await expect(active).not.toHaveAttribute('data-pane-id', first ?? '')
      const second = await active.getAttribute('data-pane-id')

      await win.keyboard.press(chords.focusLeft)
      await expect(active).toHaveAttribute('data-pane-id', first ?? '')
      await expect(active.locator('.xterm-helper-textarea')).toBeFocused()
      await win.keyboard.type('echo typed-in-left')
      await expect(win.locator(`.pane[data-pane-id="${first}"] .xterm-rows`)).toContainText(
        'echo typed-in-left',
      )

      await win.keyboard.press(chords.focusRight)
      await expect(active).toHaveAttribute('data-pane-id', second ?? '')

      await win.keyboard.press(chords.zoomPane)
      await expect(win.locator('.pane:visible')).toHaveCount(1)
      await win.keyboard.press(chords.zoomPane)
      await expect(win.locator('.pane:visible')).toHaveCount(2)
    } finally {
      await app.close()
    }
  },
)
