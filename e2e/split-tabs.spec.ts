import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { PROMPT, addTab, openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

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

test(
  'splitting inside a tab stack makes a split tab that keeps its terminals mounted',
  { tag: '@core' },
  async () => {
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
      await expect(
        pill.locator('[data-split-glyph="sideBySide"] .split-tab-glyph-pane'),
      ).toHaveCount(2)
      await expect(win.locator('.pane')).toHaveCount(1)
      await expect(win.locator('.pane-cell')).toHaveCount(2)
      await expect(win.locator('.pane-cell .xterm-rows')).toHaveCount(2)
      await expect(win.locator('.pane-cell .xterm-rows').nth(1)).toContainText(PROMPT, {
        timeout: 15_000,
      })

      expect(await markTerminals(win)).toBe(2)
      await tabs.nth(0).click()
      await expect(win.locator('.pane-split-body')).toHaveAttribute('data-hidden', '')
      await expect(pill).toHaveAttribute('aria-selected', 'false')

      await pill.locator('.split-tab-segment-main').first().click()
      await expect(pill).toHaveAttribute('aria-selected', 'true')
      await expect(win.locator('.pane-split-body')).not.toHaveAttribute('data-hidden', '')
      expect(await markedTerminals(win)).toBe(2)
      await expect(win.locator('.pane-cell .xterm-rows').first()).toContainText('split-left-marker')

      await pill
        .getByRole('button', { name: /^Close / })
        .last()
        .click()
      await expect(strip.locator('.pane-split-tab')).toHaveCount(0, { timeout: 15_000 })
      await expect(tabs).toHaveCount(2)
      await expect(win.locator('.xterm-rows:visible')).toContainText('split-left-marker')
    } finally {
      await app.close()
    }
  },
)

test('a split tab of four panes shows each title as a readable segment', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await addTab(win)
    const strip = win.getByRole('tablist')
    await expect(strip.getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.xterm-rows:visible')).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm:visible').click()

    const pill = strip.locator('.pane-split-tab')
    const segments = pill.locator('.split-tab-segment')
    for (const count of [2, 3, 4]) {
      await win.keyboard.press(chords.splitRight)
      await expect(segments).toHaveCount(count, { timeout: 15_000 })
      await expect(win.locator('.pane-cell .xterm-rows').nth(count - 1)).toContainText(PROMPT, {
        timeout: 15_000,
      })
    }

    await expect(segments.locator('.pane-kind')).toHaveCount(0)
    await expect(pill.locator('.split-tab-glyph')).toBeVisible()
    const titles = await segments
      .locator('.title')
      .evaluateAll((els) =>
        els.map((el) => ({ width: el.clientWidth, cut: el.scrollWidth > el.clientWidth })),
      )
    expect(titles).toHaveLength(4)
    for (const title of titles) if (title.cut) expect(title.width).toBeGreaterThanOrEqual(80)
  } finally {
    await app.close()
  }
})
