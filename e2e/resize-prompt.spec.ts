import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'

/**
 * Regression: narrowing a pane (split/resize) must not duplicate the shell prompt.
 *
 * The bug: the prompt line effectively spans the full width (right-aligned RPROMPT at the
 * last column), so when a split narrows the pane, xterm's reflow wraps the OLD prompt line
 * into extra rows; the shell's SIGWINCH redraw only clears from the row it believes the
 * prompt starts on, stranding the wrapped rows above — 1 real prompt became 3 lines, and
 * every further resize added more. Fix (kitty/warp-style, `Terminal.tsx`): while sitting at
 * an OSC-133 prompt, erase the prompt region before applying the resize, so the shell's
 * redraw repaints ONE fresh prompt and reflow has nothing to strand.
 *
 * Note: this reproduces meaningfully only when the shell draws a prompt (zsh/bash with
 * integration). With a prompt-less/foreign shell the count is 0 or 1 either way, so the
 * assertion still holds — the test never false-fails, it just loses its teeth.
 */
test('splitting a pane does not duplicate the existing prompt', async () => {
  test.setTimeout(60_000)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const leftRows = win.locator('.xterm-rows').first()
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await expect(leftRows).toContainText(/[❯$%#]/, { timeout: 15_000 })
    // Let async prompt segments (p10k battery/clock) finish their first paint.
    await win.waitForTimeout(2_000)

    const countPrompts = async (): Promise<number> => {
      const text = await leftRows.innerText()
      return text.split('\n').filter((l) => l.includes('❯')).length
    }
    expect(await countPrompts()).toBe(1)

    // Split right — narrows the existing left pane, forcing a pty resize + prompt redraw.
    await win.locator('.pane.active .pane-actions .iconbtn').first().click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })

    // Sample over several seconds: the count must STAY 1 (the bug minted strands at resize
    // time; later samples also catch any slow periodic-redraw drift).
    let elapsed = 0
    for (const t of [500, 2000, 4000]) {
      await win.waitForTimeout(t - elapsed)
      elapsed = t
      expect(await countPrompts(), `prompt lines ${t}ms after split`).toBe(1)
    }

    // The shell must still be live at the right size: run a command in the narrowed pane.
    await win.locator('.xterm').first().click()
    await win.keyboard.type('echo pine_resize_$((40+2))')
    await win.keyboard.press('Enter')
    await expect(leftRows).toContainText('pine_resize_42', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
