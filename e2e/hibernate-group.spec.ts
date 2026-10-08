import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 150_000 })

const MARK = 'group-agent-507'
const RESUME_LINE = 'claude --resume e2e-group'

const AGENT = [
  '#!/bin/sh',
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-group',
  `echo "${MARK} up $*"`,
  'exec sleep 600',
  '',
].join('\n')

function shownRows(win: Page): Locator {
  return win.locator('.pane-slot:not([data-hidden]) .xterm-rows').last()
}

async function startAgent(win: Page): Promise<void> {
  await expect(shownRows(win)).toContainText(PROMPT, { timeout: 15_000 })
  await win.locator('.pane-slot:not([data-hidden]) .xterm').last().click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(shownRows(win)).toContainText(`${MARK} up`, { timeout: 15_000 })
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

async function expectResumedOnce(win: Page): Promise<void> {
  await expect
    .poll(async () => count((await shownRows(win).textContent()) ?? '', `${MARK} up`), {
      timeout: 30_000,
    })
    .toBe(2)
  const text = (await shownRows(win).textContent()) ?? ''
  expect(count(text, RESUME_LINE)).toBe(1)
  expect(count(text, 'woke from hibernation')).toBe(1)
}

test('a group hibernates and resumes the agents of all its workspaces from its header menu', async () => {
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
    await startAgent(win)

    await win.locator('.rail-tab-main').first().click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Move to new group' }).click()
    const name = win.getByRole('textbox', { name: 'Group name' })
    await name.fill('build')
    await name.press('Enter')

    await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    const members = win.locator('.rail-group-members .rail-row')
    await expect(members).toHaveCount(2)
    await startAgent(win)

    const head = win.locator('.rail-group-head')
    const asleep = members.getByRole('img', { name: 'Hibernated' })
    await head.click({ button: 'right' })
    await expect(win.getByRole('menuitem', { name: 'Resume agents' })).toHaveCount(0)
    await win.getByRole('menuitem', { name: 'Hibernate agents' }).click()
    await expect(asleep).toHaveCount(2, { timeout: 15_000 })

    await head.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Resume agents' }).click()
    await expect(asleep).toHaveCount(0)
    await expectResumedOnce(win)

    await members.first().locator('.rail-tab-main').click()
    await expectResumedOnce(win)

    await head.click({ button: 'right' })
    await expect(win.getByRole('menuitem', { name: 'Hibernate agents' })).toBeEnabled()
    await expect(win.getByRole('menuitem', { name: 'Resume agents' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
