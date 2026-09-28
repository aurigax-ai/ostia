import { _electron as electron, expect, test } from '@playwright/test'
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

    await win.keyboard.type('echo pine_first_$((1+1))')
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_first_2', { timeout: 15_000 })
    await win.keyboard.type("printf 'pine_out_a\\npine_out_b   \\n'")
    await win.keyboard.press('Enter')
    await expect(rows).toContainText('pine_out_b', { timeout: 15_000 })

    const gutters = win.locator('.block-gutter')
    await expect(gutters).toHaveCount(2, { timeout: 10_000 })

    await gutters.nth(1).click()
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(win.locator('.block-frame')).toHaveCount(1)

    await gutters.nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy output' }).click()
    await expect.poll(clipboard).toBe('pine_out_a\npine_out_b')

    await expect
      .poll(() =>
        win.evaluate(
          () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
        ),
      )
      .toBe(true)
    await win.keyboard.press('Control+Shift+ArrowUp')
    await expect(gutters.nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'false')
    await win.keyboard.press('Control+Shift+ArrowDown')
    await expect(gutters.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await win.keyboard.press('Escape')
    await expect(win.locator('.block-frame')).toHaveCount(0)

    await win.keyboard.press('Control+Shift+H')
    const search = win.getByPlaceholder('Search commands from every pane…')
    await expect(search).toBeVisible({ timeout: 5_000 })
    await search.fill('pine_first')
    await win.getByRole('option', { name: /echo pine_first/ }).click()
    await expect(search).toHaveCount(0)
    await win.keyboard.press('Enter')

    await expect(gutters).toHaveCount(3, { timeout: 15_000 })
    await gutters.nth(2).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy command', exact: true }).click()
    await expect.poll(clipboard).toBe('echo pine_first_$((1+1))')
  } finally {
    await app.close()
  }
})
