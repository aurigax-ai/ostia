import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { PROMPT, openWorkspace } from './helpers'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function run(win: Page, line: string): Promise<void> {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

function rows(win: Page, index: number): Locator {
  return win.locator('.xterm-rows').nth(index)
}

function callerHasFocus(win: Page): Promise<boolean> {
  return win.evaluate(() => {
    const active = document.activeElement
    return (
      active?.classList.contains('xterm-helper-textarea') === true &&
      active.closest('.xterm') === document.querySelectorAll('.xterm')[0]
    )
  })
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

test('ostia process run shows the command in a terminal tab the human can watch', async () => {
  const dataHome = freshDataHome()
  let { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await win.locator('.xterm').first().click()

    await run(
      win,
      "ostia process run \"printf '\\033]0;hijack\\007'; echo hello-from-$((40+2)) 'two  words' && sleep 30\" --name demo",
    )

    await expect(tabs).toHaveCount(2, { timeout: 15_000 })
    await expect(tabs.nth(1)).toContainText('demo')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')
    await expect(rows(win, 1)).toContainText('hello-from-42 two  words', { timeout: 20_000 })
    await expect(tabs.nth(1)).toContainText('demo')
    await expect(tabs.nth(1)).not.toContainText('hijack')
    await expect(rows(win, 0)).toContainText('"name":"demo"')
    await expect(rows(win, 0)).not.toContainText('hello-from-42')
    expect(await callerHasFocus(win)).toBe(true)

    await run(win, 'ostia process ls')
    await expect(rows(win, 0)).toContainText(/demo\s+running/, { timeout: 15_000 })

    await run(win, 'ostia process logs demo')
    await expect(rows(win, 0)).toContainText('hello-from-42 two  words', { timeout: 15_000 })
    await expect(rows(win, 0)).toContainText('(cursor=')

    await run(win, 'ostia process kill demo && ostia process ls')
    await expect(rows(win, 0)).toContainText(/demo\s+exited\(130\)/, { timeout: 15_000 })
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toContainText('demo')

    await run(win, 'ostia process restart demo')
    await expect
      .poll(async () => occurrences((await rows(win, 1).textContent()) ?? '', 'hello-from-42'), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2)
    await expect(win.locator('.xterm')).toHaveCount(2)
    await run(win, 'ostia process ls')
    await expect(rows(win, 0)).toContainText(/demo\s+running/, { timeout: 15_000 })
    expect(await callerHasFocus(win)).toBe(true)

    await tabs.nth(1).click()
    await expect(win.locator('.xterm').nth(1)).toBeVisible()
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await quit(app)
    ;({ app, win } = await launch(dataHome))
    const restored = win.getByRole('tablist').getByRole('tab')
    await expect(restored).toHaveCount(2, { timeout: 20_000 })
    await expect(restored.nth(1)).toContainText('demo')
    await restored.nth(0).click()
    await expect(rows(win, 0)).toContainText('workspace restored', { timeout: 20_000 })
    await win.locator('.xterm').first().click()
    await run(win, 'ostia process ls')
    await expect(rows(win, 0)).toContainText('(no tracked processes)', { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('a pane types into and reads a tab it opened, and asks the human for any other pane', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch(freshDataHome())
  try {
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    await run(win, 'ostia pane.splitRight')
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(rows(win, 1)).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.xterm').first().click()

    await run(
      win,
      `OTHER=$(ostia pane.list | grep '"paneId"' | grep -v "$OSTIA_PANE_ID" | head -1 | cut -d'"' -f4)`,
    )
    await run(win, 'ostia pane send "$OTHER" intruder --enter || echo SEND-$((1+1))-REFUSED')
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('type into other terminal panes')
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(rows(win, 0)).toContainText('denied: type-other-pane', { timeout: 15_000 })
    await expect(rows(win, 0)).toContainText('SEND-2-REFUSED')
    await expect(rows(win, 1)).not.toContainText('intruder')

    await win.locator('.xterm').first().click()
    await run(win, 'ostia pane read "$OTHER" || echo READ-$((1+1))-REFUSED')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('read the screen of other terminal panes')
    await card.getByRole('button', { name: 'Deny' }).click()
    await expect(rows(win, 0)).toContainText('READ-2-REFUSED', { timeout: 15_000 })

    await win.locator('.xterm').first().click()
    await run(win, 'ostia process run "cat" --name echo')
    await expect(win.locator('.xterm')).toHaveCount(3, { timeout: 15_000 })
    await run(
      win,
      'until ostia process ls | grep -q running; do sleep 0.2; done; ostia pane send echo "sum-$((20+3))" --enter; sleep 1; ostia pane read echo',
    )
    const caller = win.locator('.xterm-rows').filter({ hasText: 'SEND-2-REFUSED' })
    await expect(caller).toContainText('sum-23', { timeout: 30_000 })
    await expect(card).toHaveCount(0)
    await expect(win.locator('.xterm-rows').filter({ hasText: 'sum-23' })).toHaveCount(2)

    await run(win, 'ostia pane key echo ctrl-d && sleep 1 && ostia process ls')
    await expect(caller).toContainText(/echo\s+exited\(0\)/, { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('tabs a pane opens with ostia process run line up beside it in launch order', async () => {
  const { app, win } = await launch(freshDataHome())
  try {
    await openWorkspace(win)
    const tabs = win.getByRole('tablist').getByRole('tab')
    await win.locator('.xterm').first().click()

    await run(win, 'for n in first second third; do ostia process run "sleep 30" --name "$n"; done')

    await expect(tabs).toHaveCount(4, { timeout: 20_000 })
    await expect(tabs.nth(1)).toContainText('first')
    await expect(tabs.nth(2)).toContainText('second')
    await expect(tabs.nth(3)).toContainText('third')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    expect(await callerHasFocus(win)).toBe(true)
  } finally {
    await quit(app)
  }
})
