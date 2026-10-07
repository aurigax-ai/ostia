import { isMac } from './chords'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('probe: Escape before the palette input has focus', async () => {
  test.setTimeout(240_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    const rows: string[] = []
    for (let i = 0; i < 25; i++) {
      await win.locator('.xterm').first().click()
      await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
      await win.keyboard.press(isMac ? 'Meta+Shift+p' : 'Control+Shift+P')
      await expect(palette).toBeVisible()
      const focus = await win.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return el ? `${el.tagName}.${el.className.split(' ')[0]}:${el.getAttribute('role') ?? ''}` : 'none'
      })
      await win.keyboard.press('Escape')
      await win.waitForTimeout(1000)
      const open = await palette.count()
      rows.push(`${i} focusAtEscape=${focus} openAfterEscape=${open}`)
      if (open > 0) {
        await expect(palette.getByRole('combobox')).toBeFocused()
        await win.keyboard.press('Escape')
        await expect(palette).toHaveCount(0)
      }
    }
    console.log(`PROBE\n${rows.join('\n')}`)
  } finally {
    await app.close()
  }
})
