import { chords } from './chords'
import { isolatedLaunch } from './dataHome'
import { SLOW_FRAME_MS, fastFrames, slowFrames } from './frames'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

test('Escape right after the palette chord in a terminal closes the palette and never reaches the shell', async () => {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    await win.locator('.xterm').first().click()
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('cat -v\n')

    await slowFrames(win)
    await win.keyboard.press(chords.palette)
    await win.keyboard.press('Escape')
    const palette = win.getByRole('dialog', { name: 'Command palette' })
    await expect(palette).toBeHidden({ timeout: SLOW_FRAME_MS * 4 })
    await fastFrames(win)

    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused()
    await win.keyboard.type('after-palette\n')
    await expect
      .poll(async () =>
        (await rows.innerText()).split('\n').filter((l) => l.trim() === 'after-palette'),
      )
      .toHaveLength(2)
    await expect(rows).not.toContainText('^[')
  } finally {
    await app.close()
  }
})
