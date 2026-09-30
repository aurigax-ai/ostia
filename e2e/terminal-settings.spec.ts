import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

async function launch() {
  const app = await electron.launch(isolatedLaunch())
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function openSettings(win: import('@playwright/test').Page, section: string) {
  await win.locator('.deck-rail').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: section }).click()
  return settings
}

async function rowHeight(win: import('@playwright/test').Page): Promise<number> {
  return win
    .locator('.xterm-rows > div')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height)
}

test('changing the terminal line height in Settings resizes terminal rows', async () => {
  const { app, win } = await launch()
  try {
    const before = await rowHeight(win)
    const settings = await openSettings(win, 'Appearance')
    await settings.getByRole('spinbutton', { name: 'Terminal line height' }).fill('2')
    await win.keyboard.press('Escape')
    await expect.poll(() => rowHeight(win)).toBeGreaterThan(before * 1.5)
  } finally {
    await app.close()
  }
})

test('copy on select puts selected terminal text on the clipboard', async () => {
  const { app, win } = await launch()
  try {
    const settings = await openSettings(win, 'Terminal')
    await settings.getByRole('switch', { name: 'Copy on select' }).click()
    await win.keyboard.press('Escape')
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))

    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await win.keyboard.type('clear; echo pinecopy42')
    await win.keyboard.press('Enter')
    const output = rows.locator('div', { hasText: /^pinecopy42\s*$/ }).first()
    await expect(output).toHaveCount(1, { timeout: 15_000 })
    await expect(
      output.locator('xpath=following-sibling::div').filter({ hasText: /[❯$%#]/ }).first(),
    ).toBeAttached({ timeout: 15_000 })
    const box = await output.boundingBox()
    if (!box) throw new Error('output row has no box')
    await win.mouse.dblclick(box.x + 20, box.y + box.height / 2)

    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('pinecopy42')
  } finally {
    await app.close()
  }
})
