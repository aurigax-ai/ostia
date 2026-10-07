import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const DEEP_DIR = 'alpha-projects/beta-clients/gamma-service/delta-api'

async function railWidth(win: Page): Promise<number> {
  const box = await win.locator('.deck-rail').boundingBox()
  if (!box) throw new Error('rail not laid out')
  return Math.round(box.width)
}

async function dragRailEdge(win: Page, dx: number): Promise<void> {
  const handle = win.getByRole('separator', { name: 'Resize sidebar' })
  const box = await handle.boundingBox()
  if (!box) throw new Error('rail handle not laid out')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await win.mouse.move(x, y)
  await win.mouse.down()
  await win.mouse.move(x + dx / 2, y, { steps: 8 })
  await win.mouse.move(x + dx, y, { steps: 8 })
  await win.mouse.up()
}

test('the rail edge drags wider, shows more of the folder, survives a restart and resets', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  mkdirSync(join(launch.home, DEEP_DIR), { recursive: true })

  let app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await win.keyboard.type(`cd ${DEEP_DIR} && echo cd_$((40+2))_done`)
    await win.keyboard.press('Enter')
    await expect(win.locator('.xterm-rows').first()).toContainText('cd_42_done', {
      timeout: 15_000,
    })

    const path = win.locator('.rail-tab').first().locator('.rail-meta-path')
    await expect(path).toContainText('delta-api', { timeout: 10_000 })
    await expect(path).toContainText('…')
    const narrowText = (await path.textContent()) ?? ''
    expect(await railWidth(win)).toBe(240)

    await dragRailEdge(win, 200)
    expect(await railWidth(win)).toBe(440)
    const handle = win.getByRole('separator', { name: 'Resize sidebar' })
    await expect(handle).toHaveAttribute('aria-valuenow', '440')
    await expect(path).toHaveText(`~/${DEEP_DIR}`)
    expect(narrowText.length).toBeLessThan(`~/${DEEP_DIR}`.length)

    const selected = await win.evaluate(() => window.getSelection()?.toString() ?? '')
    expect(selected).toBe('')
  } finally {
    await app.close()
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.rail-tab').first()).toBeVisible({ timeout: 15_000 })
    expect(await railWidth(win)).toBe(440)

    await win.getByRole('separator', { name: 'Resize sidebar' }).dblclick()
    await expect.poll(() => railWidth(win), { message: 'rail back at the default width' }).toBe(240)
  } finally {
    await app.close()
  }
})

test('dragging the rail far left collapses it and hides the handle; toggling restores the width', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await dragRailEdge(win, 60)
    expect(await railWidth(win)).toBe(300)

    await dragRailEdge(win, -260)
    const rail = win.locator('.deck-rail')
    await expect(rail).toHaveClass(/\bcollapsed\b/)
    await expect(win.getByRole('separator', { name: 'Resize sidebar' })).toHaveCount(0)

    await win.keyboard.press('Control+Shift+B')
    await expect(rail).not.toHaveClass(/\bcollapsed\b/)
    await expect.poll(() => railWidth(win)).toBe(300)
  } finally {
    await app.close()
  }
})
