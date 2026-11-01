import { isolatedLaunch } from './dataHome'
import { expectHeld, openWorkspace } from './helpers'
import { _electron as electron, expect, type Locator, test } from './test'

async function promptLines(rows: Locator): Promise<number> {
  return (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
}

test('splitting a pane does not duplicate the existing prompt', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const leftRows = win.locator('.terminal-text').first()
    await expectHeld(() => promptLines(leftRows), 1, 1_000)

    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.ghostty-host')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.terminal-text').nth(1)).toContainText('❯', { timeout: 15_000 })
    await expectHeld(() => promptLines(leftRows), 1, 3_000, 'prompt lines after the split')

    await win.locator('.ghostty-host').first().click()
    await win.keyboard.type('echo ostia_resize_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(leftRows).toContainText('ostia_resize_42', { timeout: 15_000 })
    await expect
      .poll(() => promptLines(leftRows), { message: 'prompt lines after the split' })
      .toBe(2)
  } finally {
    await app.close()
  }
})

test('drag-resizing the window keeps command output and a single prompt', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.terminal-text').first()
    await win.locator('.ghostty-host').first().click()
    await win.keyboard.type("printf 'ostia_out_%s\\n' 1 2 3")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_out_3', { timeout: 15_000 })
    await expect.poll(() => promptLines(rows)).toBe(2)

    const setWidth = (w: number) =>
      app.evaluate(({ BrowserWindow }, width) => {
        const b = BrowserWindow.getAllWindows()[0]
        b.setSize(width, b.getSize()[1])
      }, w)
    const widths: number[] = []
    for (let w = 1400; w >= 700; w -= 25) widths.push(w)
    for (let w = 700; w <= 1400; w += 25) widths.push(w)
    for (let i = 0; i < 20; i++) widths.push(i % 2 ? 900 : 1100)
    for (const w of widths) {
      await setWidth(w)
      await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    }

    await win.keyboard.type('echo ostia_flush_$((1+1))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_flush_2', { timeout: 15_000 })
    await expect.poll(() => promptLines(rows)).toBe(3)
    await expectHeld(() => promptLines(rows), 3, 2_000)

    const text = await rows.innerText()
    for (const n of [1, 2, 3]) expect(text).toContain(`ostia_out_${n}`)
  } finally {
    await app.close()
  }
})
