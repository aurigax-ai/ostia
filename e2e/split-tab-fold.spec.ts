import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultChord, isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

test('a split tab folds to one chip with its pane count and unfolds on an attention jump or a click', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-fold-'))
  const go = join(dir, 'go')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    await typeLine(
      win,
      `ostia process run "while [ ! -e ${go} ]; do sleep 0.2; done; ostia state done printed" --name w1 --tab workers`,
    )
    await typeLine(win, 'ostia process run "echo w2-ready" --name w2 --tab workers')
    const segments = win.locator('.split-tab-segment')
    await expect(segments).toHaveCount(2, { timeout: 30_000 })
    await segments.filter({ hasText: 'w2' }).locator('.split-tab-segment-main').click()

    const head = win.getByRole('button', { name: 'Fold workers' })
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(win.locator('.split-tab-fold')).toHaveCount(0)
    await head.click()
    const chip = win.locator('.pane-split-tab.folded')
    await expect(chip.getByRole('tab')).toHaveAttribute('aria-expanded', 'false')
    await expect(segments).toHaveCount(0)

    writeFileSync(go, '')
    await expect(chip.getByRole('tab')).toHaveAttribute('aria-label', /1 done/, {
      timeout: 15_000,
    })
    await expect(chip).toHaveAttribute('data-attention', 'done')

    await win.keyboard.press(defaultChord('attention.jumpToLatest', isMac))
    await expect(chip).toHaveCount(0)
    await expect(segments).toHaveCount(2)
    await expect(segments.filter({ hasText: 'w1' })).toHaveClass(/focused/)

    await win.getByRole('button', { name: 'Fold workers' }).click()
    await expect(chip).toHaveCount(1)
    await chip.getByRole('tab').click()
    await expect(chip).toHaveCount(0)
    await expect(segments).toHaveCount(2)

    await win.getByRole('button', { name: 'Fold workers' }).focus()
    await win.keyboard.press('Enter')
    await expect(chip).toHaveCount(1)
    await chip.getByRole('tab').focus()
    await win.keyboard.press('Space')
    await expect(chip).toHaveCount(0)

    await win.locator('.split-tab-name').dblclick()
    await expect(win.getByRole('textbox', { name: 'Rename split tab' })).toBeVisible()
    await expect(chip).toHaveCount(0)
    await expect(segments).toHaveCount(2)
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
