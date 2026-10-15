import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultChord, isMac } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, restartApp, typeLine } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

function segment(win: Page, name: string): Locator {
  return win.locator('.split-tab-segment', { hasText: name })
}

function cell(win: Page, id: string): Locator {
  return win.locator(`.pane-cell[data-cell-id="${id}"]`)
}

function strip(win: Page, id: string): Locator {
  return win.locator(`.pane-strip[data-strip-id="${id}"]`)
}

async function area(target: Locator): Promise<number> {
  const box = await target.boundingBox()
  return box ? box.width * box.height : 0
}

test('collapsed panes of a split tab keep running as strips, expand on focus and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-collapse-'))
  const go = join(dir, 'go')
  const dataHome = freshDataHome()
  const ids: Record<string, string> = {}
  let app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    const wait = `while [ ! -e ${go} ]; do sleep 0.2; done`
    await typeLine(
      win,
      `ostia process run "${wait}; echo printed-while-collapsed; ostia state done printed" --name w1 --tab workers`,
    )
    await typeLine(win, 'ostia process run "echo w2-ready" --name w2 --tab workers')
    await typeLine(
      win,
      `ostia process run "${wait}; printf '\\033]9;%s\\007' needs-a-look" --name w3 --tab workers`,
    )
    await typeLine(win, 'ostia process run "echo w4-ready" --name w4 --tab workers')
    await expect(win.locator('.split-tab-segment')).toHaveCount(4, { timeout: 30_000 })
    for (const name of ['w1', 'w2', 'w3', 'w4']) {
      ids[name] = (await segment(win, name).getAttribute('data-segment-id')) ?? ''
    }

    await segment(win, 'w4').locator('.split-tab-segment-main').click()
    await expect(cell(win, ids.w4)).toBeVisible()
    const before = { w2: await area(cell(win, ids.w2)), w4: await area(cell(win, ids.w4)) }

    await segment(win, 'w1').getByRole('button', { name: 'Collapse w1' }).click()
    await segment(win, 'w3').locator('.split-tab-segment-main').click()
    await win.keyboard.press(defaultChord('pane.collapse', isMac))

    await expect(win.locator('.pane-strip')).toHaveCount(2)
    await expect(strip(win, ids.w1)).toContainText('w1')
    await expect(strip(win, ids.w3)).toContainText('w3')
    await expect(cell(win, ids.w1)).toHaveCount(0)
    await expect(cell(win, ids.w3)).toHaveCount(0)
    await expect.poll(() => area(cell(win, ids.w2))).toBeGreaterThan(before.w2)
    await expect.poll(() => area(cell(win, ids.w4))).toBeGreaterThan(before.w4)

    writeFileSync(go, '')
    await expect(strip(win, ids.w1)).toHaveAttribute('data-attention', 'done', { timeout: 15_000 })
    await expect(strip(win, ids.w1)).toContainText('Done')
    await expect(strip(win, ids.w3)).toHaveAttribute('data-attention', /.+/, { timeout: 15_000 })

    await strip(win, ids.w1).getByRole('button', { name: 'Expand w1' }).click()
    await expect(strip(win, ids.w1)).toHaveCount(0)
    await expect(cell(win, ids.w1).locator('.xterm-rows')).toContainText('printed-while-collapsed')
    await expect(segment(win, 'w1')).toHaveClass(/focused/)
    await expect(strip(win, ids.w3)).toHaveCount(1)

    await restartApp(app, win)
  } finally {
    await app.close().catch(() => {})
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(strip(win, ids.w3)).toHaveCount(1, { timeout: 30_000 })
    await expect(win.locator('.pane-strip')).toHaveCount(1)
    await expect(cell(win, ids.w1)).toBeVisible()

    await win
      .locator(`.split-tab-segment[data-segment-id="${ids.w3}"] .split-tab-segment-main`)
      .click()
    await expect(strip(win, ids.w3)).toHaveCount(0)
    await expect(cell(win, ids.w3)).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
