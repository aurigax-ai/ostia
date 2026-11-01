import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import {
  openWorkspace,
  panelEval,
  quitApp,
  runInTerminal,
  shownTerminal,
  waitForPaletteSelection,
} from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 150_000 })

const RECAP = 'Fixed the cart total.'
const PROMPT = 'fix the cart total'
const NOTE = 'Set the staging key'

const HOOK_RUNNER = `
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const hooks = JSON.parse(readFileSync(join(process.argv[1], 'hooks', 'hooks.json'), 'utf8')).hooks
const events = [
  ['UserPromptSubmit', { session_id: 'e2e-1', prompt: '${PROMPT}' }],
  ['PreToolUse', { session_id: 'e2e-1', tool_name: 'Bash', tool_input: { command: 'pnpm test' } }],
  ['Stop', { session_id: 'e2e-1', last_assistant_message: '${RECAP}' }],
]
for (const [event, payload] of events) {
  for (const group of hooks[event] || []) {
    for (const hook of group.hooks) {
      if (!hook.command.includes(' agent-hook activity ')) continue
      execFileSync('sh', ['-c', hook.command], { input: JSON.stringify(payload) })
    }
  }
}
execFileSync(process.env.OSTIA_NODE, [process.env.OSTIA_CLI, 'activity', 'add', '${NOTE}', '--needs-you'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
`

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'for arg; do [ "$prev" = --plugin-dir ] && [ -z "$plugin" ] && plugin=$arg; prev=$arg; done',
  `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${HOOK_RUNNER.replaceAll("'", "'\\''")}' "$plugin"`,
  'echo fake-agent-ready',
  'exec cat',
  '',
].join('\n')

async function openActivity(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Activity: Open')
  await waitForPaletteSelection(win, 'Activity: Open')
  await win.keyboard.press('Enter')
}

test('the Activity panel shows an agent’s recap, shows its events on the toggle, and keeps both across a restart', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const bin = fakeAgentBin(dataHome, FAKE_CLAUDE)
  const env = { ...launch.env, PATH: `${bin}:${launch.env.PATH ?? ''}` }
  const text = (app: ElectronApplication, selector: string): Promise<string> =>
    panelEval(
      app,
      `[...document.querySelectorAll('${selector}')].map((el) => el.innerText).join('|')`,
    )

  let app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(win.locator('.terminal-text').first()).toContainText('fake-agent-ready', {
      timeout: 30_000,
    })

    await openActivity(win)
    await expect.poll(() => text(app, '.agent > .markdown'), { timeout: 30_000 }).toBe(RECAP)
    expect(await text(app, '.agent-name')).toMatch(/^(zsh|bash|sh|fish)$/)

    await panelEval(app, `document.querySelector('[data-timeline="true"]').click(); 'ok'`)
    await expect.poll(() => text(app, '.turn .prompt'), { timeout: 15_000 }).toBe(PROMPT)
    expect(await text(app, '.turn .markdown')).toBe(RECAP)
    expect(await text(app, '.actions-toggle')).toBe('Ran 1 command')
    expect(await panelEval(app, `document.querySelector('.more').hidden`)).toBe('true')
    expect(
      await panelEval(
        app,
        `['.agent', '.workspace'].map((s) => getComputedStyle(document.querySelector(s)).borderTopWidth).join()`,
      ),
    ).toBe('0px,0px')
    expect(await panelEval(app, `document.querySelector('.action-list').hidden`)).toBe('true')
    await panelEval(app, `document.querySelector('.actions-toggle').click(); 'ok'`)
    await expect
      .poll(() => panelEval(app, `document.querySelector('.actions-toggle').ariaExpanded`))
      .toBe('true')
    expect(await text(app, '.event')).toBe('Ran\npnpm test')
    await win.keyboard.press(chords.splitRight)
    await expect.poll(() => text(app, '.stream-text'), { timeout: 15_000 }).toMatch(/\b2 started\b/)
    await panelEval(app, `document.querySelector('.agent-head').click(); 'ok'`)
    await expect(win.locator('.ghostty-host textarea').first()).toBeFocused({ timeout: 15_000 })
    expect(await text(app, '.note:not([hidden])')).toBe('')
    expect(await text(app, '.note-text')).toBe('')
    const panel = win.locator('#right-panel')
    await panel.getByRole('tab', { name: 'Inbox 1' }).click()
    const card = panel.locator('[data-inbox-note]')
    await expect(card).toContainText(NOTE, { timeout: 15_000 })
    await win.locator('.ghostty-host textarea').first().blur()
    await card.getByText(NOTE).click()
    await expect(win.locator('.ghostty-host textarea').first()).toBeFocused({ timeout: 15_000 })
    await panel.getByRole('tab', { name: 'Activity' }).click()
    await expect
      .poll(
        () => {
          const file = join(dataHome, 'userData', 'settings.json')
          return existsSync(file) ? readFileSync(file, 'utf8') : ''
        },
        { timeout: 15_000 },
      )
      .toContain('"showActivity": true')
  } finally {
    await quitApp(app)
  }

  app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.ghostty-host').first()).toBeVisible({ timeout: 30_000 })
    await openActivity(win)
    await expect
      .poll(() => panelEval(app, `document.querySelector('[data-timeline="true"]').ariaPressed`), {
        timeout: 30_000,
      })
      .toBe('true')
    await expect.poll(() => text(app, '.turn .markdown'), { timeout: 15_000 }).toBe(RECAP)
    expect(await text(app, '.turn .prompt')).toBe(PROMPT)
    expect(await text(app, '.actions-toggle')).toBe('Ran 1 command')
  } finally {
    await app.close()
  }
})

test('a needs-you item an agent adds is counted in the sidebar and marked done by the human', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const idFile = join(dataHome, 'added-id.txt')
  const count = (win: Page) => win.locator('.ext-item-text', { hasText: 'Needs you' })

  const app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(
      win,
      `ostia activity add "Check the staging deploy" --needs-you > '${idFile}'`,
      shownTerminal(win),
    )
    await expect
      .poll(() => (existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : ''), {
        timeout: 30_000,
      })
      .toMatch(/^[a-z2-7]{10}$/)
    await expect(count(win)).toBeVisible({ timeout: 15_000 })
    await expect(count(win).locator('xpath=preceding-sibling::*[1]')).toHaveText('1')

    await openActivity(win)
    const panel = win.locator('#right-panel')
    await panel.getByRole('tab', { name: 'Inbox 1' }).click()
    const card = panel.locator('[data-inbox-note]')
    await expect(card).toContainText('Check the staging deploy', { timeout: 30_000 })
    await card.getByRole('button', { name: 'Mark done' }).click()
    await expect(count(win)).toHaveCount(0, { timeout: 15_000 })
    await panel.getByRole('tab', { name: 'Activity' }).click()
    await expect
      .poll(() => panelEval(app, `document.querySelector('.needs-you')?.innerText ?? ''`))
      .toBe('Done')
  } finally {
    await quitApp(app)
  }
})
