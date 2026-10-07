import { _electron as electron, expect, test } from './test'
import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('blocks: select, copy output, navigate by chord, and reinsert from history', async () => {
  test.setTimeout(90_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const rows = win.locator('.xterm-rows').first()
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())

    await win.keyboard.type('echo ostia_first_$((1+1))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_first_2', { timeout: 15_000 })
    await win.keyboard.type("printf 'ostia_out_a\\nostia_out_b   \\n'")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('ostia_out_b', { timeout: 15_000 })

    const gutters = win.locator('.block-gutter')
    await expect(gutters).toHaveCount(2, { timeout: 10_000 })

    await gutters.nth(1).click()
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(win.locator('.block-frame')).toHaveCount(1)

    await gutters.nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy output' }).click()
    await expect.poll(clipboard).toBe('ostia_out_a\nostia_out_b')

    await expect
      .poll(() =>
        win.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
        ),
      )
      .toBe(true)
    await win.keyboard.press(chords.blockPrev)
    await expect(gutters.nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'false')
    await win.keyboard.press(chords.blockNext)
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await win.keyboard.press('Escape')
    await expect(win.locator('.block-frame')).toHaveCount(0)

    await win.keyboard.press(chords.history)
    const search = win.getByPlaceholder('Search commands from every pane…')
    await expect(search).toBeVisible({ timeout: 5_000 })
    await search.fill('ostia_first')
    await win.getByRole('option', { name: /echo ostia_first/ }).click()
    await expect(search).toHaveCount(0)
    await win.keyboard.press('Enter')

    await expect(gutters).toHaveCount(3, { timeout: 15_000 })
    await gutters.nth(2).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy command', exact: true }).click()
    await expect.poll(clipboard).toBe('echo ostia_first_$((1+1))')
  } finally {
    await app.close()
  }
})
