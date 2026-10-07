import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import { PROMPT, openWorkspace } from './helpers'

const LINE_AGENT =
  '#!/bin/sh\necho fake-agent-ready\nwhile IFS= read -r line; do echo "agent-got:$line"; done\n'

async function launch(agentScript?: string): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  const config = isolatedLaunch(dataHome)
  const path = agentScript
    ? `${fakeAgentBin(dataHome, agentScript)}:${config.env.PATH}`
    : config.env.PATH
  const app = await electron.launch({ ...config, env: { ...config.env, PATH: path } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  return { app, win }
}

async function run(win: Page, command: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

function dashboard(win: Page): Locator {
  return win.getByRole('region', { name: 'Dashboard', exact: true })
}

function questionCard(win: Page): Locator {
  return dashboard(win).getByRole('article', { name: /^Question from/ })
}

async function openDashboard(win: Page, waiting: number): Promise<void> {
  await win
    .locator('.topbar')
    .getByRole('button', { name: `Dashboard, ${waiting} waiting for you` })
    .click()
  await expect(dashboard(win)).toBeVisible()
}

test('ostia ask with choices waits, shows on the dashboard and prints the choice and comment', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    const rows = win.locator('.xterm-rows').first()
    const workspaceName = (await win.locator('.rail-row .tab-title').first().textContent()) ?? ''
    expect(workspaceName).not.toBe('')

    await run(
      win,
      'ostia ask "Which database should the migration target?" --context "Adding the refunds table. Staging has last week\'s data." --choice staging --choice production; echo "ASK-EXIT:$?"',
    )

    const notice = win.getByRole('region', { name: 'Agent asks' })
    await expect(notice).toContainText('Which database should the migration target?', {
      timeout: 20_000,
    })
    await expect(
      win.locator('.rail-row').getByRole('img', { name: 'Waiting for input' }),
    ).toBeVisible()
    await expect(rows).not.toContainText(/ASK-EXIT:\d/)

    await openDashboard(win, 1)
    const card = questionCard(win)
    await expect(card).toContainText(workspaceName)
    await expect(card).toContainText('Which database should the migration target?')
    await expect(card).toContainText("Adding the refunds table. Staging has last week's data.")
    const railPath = (await win.locator('.rail-row .rail-meta-path').first().textContent()) ?? ''
    expect(railPath).not.toBe('')
    await expect(card.locator('.font-mono').first()).toHaveText(railPath)
    await expect(card.getByRole('radio').first()).toBeFocused()
    await expect(card.getByRole('button', { name: 'Send' })).toBeDisabled()

    await card.getByRole('radio', { name: 'production' }).click()
    await card.getByLabel('Comment or reply').fill('after the 02:00 backup')
    await card.getByRole('button', { name: 'Send' }).click()

    await expect(card).toContainText('Sent to the agent')
    await expect(questionCard(win)).toHaveCount(0)
    await expect(dashboard(win)).toContainText('Nothing is waiting for you')
    await win.keyboard.press('Escape')
    await expect(dashboard(win)).toHaveCount(0)

    await expect(rows).toContainText('ASK-EXIT:0', { timeout: 15_000 })
    await expect(rows).toContainText('production')
    await expect(rows).toContainText('after the 02:00 backup')
    await expect(
      win.locator('.rail-row').getByRole('img', { name: 'Waiting for input' }),
    ).toHaveCount(0)

    await run(win, 'ostia ask "Continue with the deploy?"; echo "ASK-EXIT:$?"')
    await expect(notice).toBeVisible({ timeout: 20_000 })
    await notice.getByRole('button', { name: 'Answer' }).click()
    await expect(questionCard(win)).toContainText('Continue with the deploy?')
    await expect(questionCard(win).getByLabel('Reply')).toBeFocused()
    await questionCard(win).getByRole('button', { name: 'Dismiss' }).click()
    await expect(questionCard(win)).toHaveCount(0)
    await dashboard(win).getByRole('button', { name: 'Close dashboard' }).click()
    await expect(rows).toContainText('dismissed by the human', { timeout: 15_000 })
    await expect(rows).toContainText('ASK-EXIT:2')
  } finally {
    await app.close()
  }
})

test('ostia ask takes a free-text reply and several choices with a comment', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch()
  try {
    const rows = win.locator('.xterm-rows').first()

    await run(win, 'ostia ask "What should the release note say?"; echo "ASK-EXIT:$?"')
    await openDashboard(win, 1)
    const card = questionCard(win)
    await expect(card.getByRole('radio')).toHaveCount(0)
    await expect(card.getByRole('checkbox')).toHaveCount(0)
    await card.getByLabel('Reply').fill('Refunds now settle in one step')
    await card.getByLabel('Reply').press('Control+Enter')
    await expect(questionCard(win)).toHaveCount(0)
    await win.keyboard.press('Escape')
    await expect(rows).toContainText('Refunds now settle in one step', { timeout: 15_000 })
    await expect(rows).toContainText('ASK-EXIT:0')

    await run(
      win,
      'clear; ostia ask "Which checks?" --choice lint --choice unit --choice e2e --multi --json; echo "ASK-EXIT:$?"',
    )
    await expect(
      win.locator('.topbar').getByRole('button', { name: 'Dashboard, 1 waiting for you' }),
    ).toBeVisible({ timeout: 20_000 })
    await win.keyboard.press('Control+Shift+D')
    await expect(dashboard(win)).toBeVisible()
    const multi = questionCard(win)
    await expect(multi.getByRole('checkbox')).toHaveCount(3)
    await multi.getByRole('checkbox', { name: 'lint' }).click()
    await multi.getByRole('checkbox', { name: 'e2e' }).click()
    await multi.getByLabel('Comment or reply').fill('skip unit, it is red on main')
    await multi.getByRole('button', { name: 'Send' }).click()
    await expect(questionCard(win)).toHaveCount(0)
    await win.keyboard.press('Escape')
    await expect(rows).toContainText(
      '{"answered":true,"choices":["lint","e2e"],"text":"skip unit, it is red on main"}',
      { timeout: 15_000 },
    )
    await expect(rows).toContainText('ASK-EXIT:0')
  } finally {
    await app.close()
  }
})

test('a message sent from the dashboard reaches the agent pane and is submitted', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(LINE_AGENT)
  try {
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText(PROMPT, { timeout: 15_000 })
    await run(win, 'claude')
    await expect(rows).toContainText('fake-agent-ready', { timeout: 15_000 })

    await win.locator('.topbar').getByRole('button', { name: 'Dashboard', exact: true }).click()
    const list = dashboard(win).getByRole('region', { name: 'Workspaces' })
    await expect(list.getByRole('list', { name: 'Agents' }).getByRole('button')).toHaveCount(1)
    await list.getByRole('button', { name: 'Message an agent' }).click()
    const composer = list.getByRole('region', { name: 'Message an agent' })
    await composer.getByLabel('Message').fill('rebase onto main first')
    await composer.getByRole('button', { name: 'Send' }).click()
    await expect(composer).toContainText('Sent to')

    await list.getByRole('button', { name: /^Open workspace/ }).click()
    await expect(dashboard(win)).toHaveCount(0)
    await expect(rows).toContainText('agent-got:rebase onto main first', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})
