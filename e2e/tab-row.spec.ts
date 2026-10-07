import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin, startFakeAgent } from './fakeAgent'
import { openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

const OSTIA_RUN = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
const MAX_W = 200
const MIN_W = 96
const TABS = 30

const WAITING_AGENT = [
  '#!/bin/sh',
  'echo fake-agent-ready',
  `${OSTIA_RUN} state waiting 'Approve the plan?'`,
  'echo fake-agent-waiting',
  'sleep 600',
  '',
].join('\n')

function widths(tabs: Locator): Promise<number[]> {
  return tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
}

async function inView(win: Page, tab: Locator): Promise<boolean> {
  const row = await win.getByRole('tablist').boundingBox()
  const box = await tab.boundingBox()
  if (!row || !box) return false
  return box.x >= row.x - 1 && box.x + box.width <= row.x + row.width + 1
}

test('a row of thirty tabs keeps tab widths in range, scrolls and points at a hidden tab that needs you', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  const bin = fakeAgentBin(dataHome, WAITING_AGENT)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await startFakeAgent(win)
    await expect(win.locator('.xterm-rows').first()).toContainText('fake-agent-waiting', {
      timeout: 15_000,
    })

    const strip = win.getByRole('tablist')
    const tabs = strip.locator('.pane-tab')
    const waiting = strip.locator('.pane-tab[data-attention="waiting"]')
    await expect(waiting).toHaveCount(1, { timeout: 10_000 })

    const newTab = win.getByRole('button', { name: 'New terminal tab' })
    await newTab.click()
    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    for (const width of await widths(tabs)) expect(Math.round(width)).toBe(MAX_W)
    await expect(win.getByRole('button', { name: /^All tabs/ })).toHaveCount(0)

    for (let count = 3; count <= TABS; count++) {
      await newTab.click()
      await expect(tabs).toHaveCount(count, { timeout: 15_000 })
    }

    for (const width of await widths(tabs)) {
      expect(width).toBeGreaterThanOrEqual(MIN_W - 0.5)
      expect(width).toBeLessThanOrEqual(MAX_W + 0.5)
    }
    const selected = strip.locator('.pane-tab.selected')
    await expect.poll(() => inView(win, selected)).toBe(true)
    expect(await inView(win, waiting)).toBe(false)

    await win
      .locator('.pane-header')
      .screenshot({ path: test.info().outputPath('tab-row-thirty.png') })

    const marker = win.getByRole('button', { name: 'Hidden tabs that need you: 1' })
    await expect(marker).toHaveAttribute('data-edge', 'start')
    await marker.click()
    await expect.poll(() => inView(win, waiting)).toBe(true)
    await expect(marker).toHaveCount(0)

    await win.getByRole('button', { name: /^All tabs/ }).click()
    await expect(win.getByRole('option')).toHaveCount(TABS)
    await win
      .locator('.pane-header')
      .screenshot({ path: test.info().outputPath('tab-row-scrolled.png') })
    await win.screenshot({ path: test.info().outputPath('tab-row-all-tabs.png') })
    await win.getByRole('option').last().click()
    await expect(win.getByRole('option')).toHaveCount(0)
    await expect.poll(() => inView(win, tabs.last())).toBe(true)
    await expect(tabs.last()).toHaveClass(/selected/)
  } finally {
    await app.close()
  }
})
