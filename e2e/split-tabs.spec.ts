import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

async function addTab(win: Page): Promise<void> {
  const strip = win.getByRole('tablist')
  const box = await strip.boundingBox()
  const lastTab = await strip.locator('.pane-tab').last().boundingBox()
  if (!lastTab || !box) throw new Error('tab strip is not laid out')
  await win.mouse.dblclick(lastTab.x + lastTab.width + 40, box.y + box.height / 2)
}

function markTerminals(win: Page): Promise<number> {
  return win.evaluate(() => {
    const terms = [...document.querySelectorAll<HTMLElement>('.pane-split-body .xterm')]
    for (const term of terms) term.dataset.splitTabMark = 'kept'
    return terms.length
  })
}

function markedTerminals(win: Page): Promise<number> {
  return win.evaluate(
    () => document.querySelectorAll('.pane-split-body .xterm[data-split-tab-mark="kept"]').length,
  )
}

test('splitting inside a tab stack makes a split tab that keeps its terminals mounted', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await addTab(win)
    const strip = win.getByRole('tablist')
    const tabs = strip.getByRole('tab')
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })

    const shown = win.locator('.xterm-rows:visible')
    await expect(shown).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm:visible').click()
    await win.keyboard.type('echo split-left-marker')
    await win.keyboard.press('Enter')
    await expect(shown).toContainText('split-left-marker')

    await win.keyboard.press(chords.splitRight)
    const pill = strip.locator('.pane-split-tab')
    await expect(pill).toHaveCount(1, { timeout: 15_000 })
    await expect(tabs).toHaveCount(2)
    await expect(pill).toHaveAttribute('aria-selected', 'true')
    await expect(pill).toHaveAttribute('aria-label', /^Split tab, side by side: /)
    await expect(pill.locator('.split-tab-segment')).toHaveCount(2)
    await expect(pill.locator('[data-split-glyph="sideBySide"] .split-tab-glyph-pane')).toHaveCount(
      2,
    )
    await expect(win.locator('.pane')).toHaveCount(1)
    await expect(win.locator('.pane-cell')).toHaveCount(2)
    await expect(win.locator('.pane-cell .xterm-rows')).toHaveCount(2)
    await expect(win.locator('.pane-cell .xterm-rows').nth(1)).toContainText(PROMPT, {
      timeout: 15_000,
    })
    await pill.screenshot({ path: test.info().outputPath('split-tab-pill.png') })
    await win
      .locator('.pane')
      .screenshot({ path: test.info().outputPath('split-tab-pane.png') })

    expect(await markTerminals(win)).toBe(2)
    await tabs.nth(0).click()
    await expect(win.locator('.pane-split-body')).toHaveAttribute('data-hidden', '')
    await expect(pill).toHaveAttribute('aria-selected', 'false')

    await pill.locator('.split-tab-segment-main').first().click()
    await expect(pill).toHaveAttribute('aria-selected', 'true')
    await expect(win.locator('.pane-split-body')).not.toHaveAttribute('data-hidden', '')
    expect(await markedTerminals(win)).toBe(2)
    await expect(win.locator('.pane-cell .xterm-rows').first()).toContainText('split-left-marker')

    await pill.getByRole('button', { name: /^Close / }).last().click()
    await expect(strip.locator('.pane-split-tab')).toHaveCount(0, { timeout: 15_000 })
    await expect(tabs).toHaveCount(2)
    await expect(win.locator('.xterm-rows:visible')).toContainText('split-left-marker')
  } finally {
    await app.close()
  }
})
