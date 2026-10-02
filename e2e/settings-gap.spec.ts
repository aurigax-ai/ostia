import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

async function launch(settings: object) {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, ...settings })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('terminal.shell starts new terminals in the chosen program with its arguments', async () => {
  const { app, win } = await launch({ terminal: { shell: '/bin/sh -i' } })
  try {
    await run(win, 'echo "shell=$0 flags=$-"')
    await expect(win.locator('.xterm-rows').first()).toContainText(/shell=\/bin\/sh flags=\S*i/, {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

test('OSC 52 sets the clipboard only while terminal.osc52Write is on', async () => {
  const { app, win } = await launch({ terminal: { osc52Write: true } })
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await run(win, "printf '\\033]52;c;%s\\a' \"$(printf pine-osc52 | base64)\"")
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 10_000 })
      .toBe('pine-osc52')
    await run(win, "printf '\\033]52;c;?\\a'")
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('pine-osc52')
  } finally {
    await app.close()
  }
})

test('OSC 52 leaves the clipboard alone by default', async () => {
  const { app, win } = await launch({})
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await run(win, "printf '\\033]52;c;%s\\a' \"$(printf pine-osc52 | base64)\"; echo osc-sent")
    await expect(win.locator('.xterm-rows').first()).toContainText('osc-sent')
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('before')
  } finally {
    await app.close()
  }
})
