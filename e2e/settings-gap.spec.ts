import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMac } from './chords'
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
