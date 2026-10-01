import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('splitting a pane does not duplicate the existing prompt', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const leftRows = win.locator('.xterm-rows').first()
    await win.waitForTimeout(2_000)

    const countPrompts = async (): Promise<number> => {
      const text = await leftRows.innerText()
      return text.split('\n').filter((l) => l.includes('❯')).length
    }
    expect(await countPrompts()).toBe(1)

    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })

    let elapsed = 0
    for (const t of [500, 2000, 4000]) {
      await win.waitForTimeout(t - elapsed)
      elapsed = t
      expect(await countPrompts(), `prompt lines ${t}ms after split`).toBe(1)
    }

    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo pine_resize_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(leftRows).toContainText('pine_resize_42', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('toggling the sidebar twice leaves exactly one prompt line', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.waitForTimeout(2_000)
    const promptLines = async (): Promise<number> =>
      (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
    expect(await promptLines()).toBe(1)

    await win.locator('.xterm').first().click()
    const rail = win.locator('.deck-rail')
    await win.keyboard.press('Control+Shift+B')
    await expect(rail).toHaveClass(/\bcollapsed\b/)
    await win.waitForTimeout(600)
    await win.keyboard.press('Control+Shift+B')
    await expect(rail).not.toHaveClass(/\bcollapsed\b/)
    await win.waitForTimeout(2_000)

    expect(await promptLines()).toBe(1)
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
    const rows = win.locator('.xterm-rows').first()
    await win.waitForTimeout(2_000)
    await win.locator('.xterm').first().click()
    await win.keyboard.type("printf 'pine_out_%s\\n' 1 2 3")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_out_3', { timeout: 15_000 })
    await win.waitForTimeout(1_000)

    const promptLines = async (): Promise<number> =>
      (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
    const before = await promptLines()

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
      await win.waitForTimeout(16)
    }
    await win.waitForTimeout(2_000)

    const text = await rows.innerText()
    for (const n of [1, 2, 3]) expect(text).toContain(`pine_out_${n}`)
    expect(await promptLines()).toBe(before)
  } finally {
    await app.close()
  }
})

test('dragging the sidebar edge keeps command output and a single prompt', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.waitForTimeout(2_000)
    await win.locator('.xterm').first().click()
    await win.keyboard.type("printf 'pine_rail_%s\\n' 1 2 3")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_rail_3', { timeout: 15_000 })
    await win.waitForTimeout(1_000)

    const promptLines = async (): Promise<number> =>
      (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length
    const before = await promptLines()

    const handle = win.getByRole('separator', { name: 'Resize sidebar' })
    const box = await handle.boundingBox()
    if (!box) throw new Error('rail handle not laid out')
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await win.mouse.move(x, y)
    await win.mouse.down()
    for (const dx of [200, -50, 150, 0, 220, 40]) {
      await win.mouse.move(x + dx, y, { steps: 30 })
    }
    await win.mouse.up()
    await win.waitForTimeout(2_000)

    const text = await rows.innerText()
    for (const n of [1, 2, 3]) expect(text).toContain(`pine_rail_${n}`)
    expect(await promptLines()).toBe(before)
  } finally {
    await app.close()
  }
})
