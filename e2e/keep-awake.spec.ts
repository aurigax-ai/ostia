import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { openWorkspace, PROMPT } from './helpers'
import { _electron as electron, expect, type Locator, type Page, test } from './test'

test.describe.configure({ timeout: 120_000 })

const MARK = 'keep-awake-agent-1475'

const AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude "e2e-keep-$OSTIA_PANE_ID"',
  `echo "${MARK} up $*"`,
  'exec sleep 600',
  '',
].join('\n')

function shownRows(win: Page): Locator {
  return win.locator('.pane-slot:not([data-hidden]) .xterm-rows').last()
}

test('the human keeps an agent tab awake from its menu and can still hibernate it', async () => {
  const testInfo = test.info()
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const bin = fakeAgentBin(dataHome, AGENT)
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: {
      ...options.env,
      HOME: isolatedHome(dataHome),
      PATH: `${bin}:${options.env.PATH ?? ''}`,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await expect(shownRows(win)).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
    await win.keyboard.type('claude')
    await win.keyboard.press('Enter')
    await expect(shownRows(win)).toContainText(`${MARK} up`, { timeout: 15_000 })

    const tab = win.locator('.pane-tab:visible').first()
    const kept = tab.getByRole('img', { name: 'Kept awake' })
    await expect(kept).toHaveCount(0)

    await tab.click({ button: 'right' })
    const item = win.getByRole('menuitemcheckbox', { name: 'Keep awake' })
    await expect(item).not.toBeChecked()
    await item.click()
    await expect(item).toBeChecked()
    await win.screenshot({ path: testInfo.outputPath('tab-menu.png') })
    await win.keyboard.press('Escape')
    await expect(kept).toBeVisible()
    await tab.screenshot({ path: testInfo.outputPath('tab-face.png') })
    const row = win.locator('.rail-row').first()
    await expect(row.getByRole('img', { name: /^Kept awake: / })).toBeVisible()
    await row.screenshot({ path: testInfo.outputPath('sidebar-row.png') })

    await tab.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Hibernate tab' }).click()
    await expect(tab.getByLabel('Hibernated')).toBeVisible({ timeout: 15_000 })

    await tab.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Wake tab' }).click()
    await expect(tab.getByLabel('Hibernated')).toHaveCount(0)

    await tab.click({ button: 'right' })
    await win.getByRole('menuitemcheckbox', { name: 'Keep awake' }).click()
    await win.keyboard.press('Escape')
    await expect(kept).toHaveCount(0)
    await expect(row.getByRole('img', { name: /^Kept awake: / })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
