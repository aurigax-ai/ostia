import { runInTerminal } from './helpers'
import { expect, type Page } from './test'

export async function setSandbox(win: Page, on: boolean): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  const item = win.getByRole('menuitemcheckbox', { name: 'Sandbox' })
  await expect(item).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await item.click()
}

export async function sandboxedShell(win: Page): Promise<void> {
  await setSandbox(win, true)
  const restart = win.getByRole('button', { name: 'Restart to apply' })
  await restart.click()
  await expect(restart).toHaveCount(0)
  const rows = win.locator('.terminal-text').first()
  await expect(async () => {
    await runInTerminal(win, 'echo sandbox=${HTTPS_PROXY:+on}')
    await expect(rows).toContainText('sandbox=on', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}
