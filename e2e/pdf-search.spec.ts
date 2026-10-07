import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { textPdf } from './pdfFixture'
import { _electron as electron, expect, test } from './test'

test('PDF text is found from the Files panel and with find in the PDF viewer', async () => {
  test.setTimeout(90_000)
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'docs'), { recursive: true })
  writeFileSync(
    join(home, 'docs', 'paper.pdf'),
    textPdf('Introduction', 'A needle on page two', 'Another needle and one more needle'),
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, env: { ...launch.env, HOME: home } })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(win.locator('.file-tree').getByRole('button', { name: 'docs' })).toBeVisible({
      timeout: 15_000,
    })

    await win.getByRole('textbox', { name: 'Search files' }).fill('needle')
    const text = win.getByRole('region', { name: 'Text' })
    await expect(text).toContainText('docs/paper.pdf', { timeout: 15_000 })
    await expect(text).toContainText('p. 2')
    await expect(text).toContainText('p. 3')

    await text.getByRole('button', { name: /Another needle/ }).click()
    const find = win.locator('.pdf-find')
    await expect(find).toBeVisible({ timeout: 15_000 })
    await expect(win.getByRole('textbox', { name: 'Find in PDF' })).toHaveValue('needle')
    await expect(win.locator('.viewer-meta')).toHaveText('Page 3 of 3')
    await expect(find).toContainText('2/3')

    await win.getByRole('textbox', { name: 'Find in PDF' }).press('Shift+Enter')
    await expect(find).toContainText('1/3')
    await expect(win.locator('.viewer-meta')).toHaveText('Page 2 of 3')
    await expect
      .poll(() =>
        win.evaluate(() => {
          const registry = (CSS as unknown as { highlights: Map<string, { size: number }> })
            .highlights
          return registry.get('ostia-find')?.size ?? 0
        }),
      )
      .toBe(1)

    await win.getByRole('textbox', { name: 'Find in PDF' }).press('Escape')
    await expect(find).toHaveCount(0)
    await win.locator('.pdf-text').click()
    await win.keyboard.press('Control+F')
    await expect(win.getByRole('textbox', { name: 'Find in PDF' })).toBeFocused()
  } finally {
    await app.close()
  }
})
