import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import {
  openWorkspace,
  quitApp,
  runInTerminal,
  shownTerminal,
  waitForPaletteSelection,
} from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 150_000 })

const RECAP = 'Fixed the cart total.'

const HOOK_RUNNER = `
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const hooks = JSON.parse(readFileSync(join(process.argv[1], 'hooks', 'hooks.json'), 'utf8')).hooks
const events = [
  ['UserPromptSubmit', { session_id: 'e2e-1', prompt: 'fix the cart total' }],
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
`

const FAKE_CLAUDE = [
  '#!/bin/sh',
  'for arg; do [ "$prev" = --plugin-dir ] && plugin=$arg; prev=$arg; done',
  `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${HOOK_RUNNER.replaceAll("'", "'\\''")}' "$plugin"`,
  'echo fake-agent-ready',
  'exec cat',
  '',
].join('\n')

function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    return guest ? String(await guest.executeJavaScript(code)) : ''
  }, script)
}

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
  const journalDir = join(dataHome, 'userData', 'extension-data', 'activity', 'journal')
  const text = (app: ElectronApplication, selector: string): Promise<string> =>
    panelEval(
      app,
      `[...document.querySelectorAll('${selector}')].map((el) => el.innerText).join('|')`,
    )
  const pressed = (app: ElectronApplication, view: string): Promise<string> =>
    panelEval(
      app,
      `document.querySelector('[data-view="${view}"]')?.getAttribute('aria-pressed') ?? ''`,
    )

  let app = await electron.launch({ ...launch, env })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await runInTerminal(win, 'claude', shownTerminal(win))
    await expect(win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
      timeout: 30_000,
    })

    await openActivity(win)
    await expect.poll(() => text(app, '.agent .recap'), { timeout: 30_000 }).toBe(RECAP)
    expect(await text(app, '.agent-name')).toBe('Claude Code')
    expect(await pressed(app, 'recap')).toBe('true')
    expect(await text(app, '.event')).toBe('')

    await panelEval(app, `document.querySelector('[data-view="activity"]').click(); 'ok'`)
    await expect
      .poll(() => text(app, '.event'), { timeout: 15_000 })
      .toBe(['Prompt\nfix the cart total', 'Ran\npnpm test', 'Stopped'].join('|'))
    expect(await pressed(app, 'activity')).toBe('true')

    await panelEval(app, `document.querySelector('.agent-head').click(); 'ok'`)
    await expect(win.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: 15_000 })
    expect(await text(app, '.note')).toBe('')

    const files = readdirSync(journalDir)
    expect(files).toHaveLength(1)
    expect(statSync(join(journalDir, files[0])).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(journalDir, files[0]), 'utf8')).toContain(RECAP)
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
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await openActivity(win)
    await expect.poll(() => pressed(app, 'activity'), { timeout: 30_000 }).toBe('true')
    await expect.poll(() => text(app, '.agent .recap'), { timeout: 15_000 }).toBe(RECAP)
    expect(await text(app, '.event')).toBe(
      ['Prompt\nfix the cart total', 'Ran\npnpm test', 'Stopped'].join('|'),
    )
  } finally {
    await app.close()
  }
})

test('a needs-you item an agent adds is counted in the sidebar, marked done by the human, and archived after the live window', async () => {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const activityDir = join(dataHome, 'userData', 'extension-data', 'activity')
  const idFile = join(dataHome, 'added-id.txt')
  const archivedFile = join(dataHome, 'archived.json')
  const count = (win: Page) => win.getByText('1 need you')

  let app = await electron.launch(launch)
  let id = ''
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
    id = readFileSync(idFile, 'utf8').trim()
    await expect(count(win)).toBeVisible({ timeout: 15_000 })

    await openActivity(win)
    await expect
      .poll(() => panelEval(app, `document.querySelector('.note-row')?.innerText ?? ''`), {
        timeout: 30_000,
      })
      .toContain('Check the staging deploy')
    await panelEval(app, `document.querySelector('.done-button').click(); 'ok'`)
    await expect(count(win)).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(() => panelEval(app, `document.querySelector('.needs-you')?.innerText ?? ''`))
      .toBe('Done')
  } finally {
    await quitApp(app)
  }

  const journalDir = join(activityDir, 'journal')
  const [file] = readdirSync(journalDir)
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const aged = readFileSync(join(journalDir, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.stringify({ ...JSON.parse(line), t: monthAgo }))
    .join('\n')
  writeFileSync(join(journalDir, file), `${aged}\n`)

  app = await electron.launch(launch)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await runInTerminal(
      win,
      `ostia activity list --archived --json > '${archivedFile}'`,
      shownTerminal(win),
    )
    await expect
      .poll(() => (existsSync(archivedFile) ? readFileSync(archivedFile, 'utf8') : ''), {
        timeout: 30_000,
      })
      .toContain(id)
    expect(JSON.parse(readFileSync(archivedFile, 'utf8'))).toEqual([
      expect.objectContaining({ id, needsYou: true, done: true }),
    ])
    const archive = join(activityDir, 'archive', file.replace(/\.jsonl$/, ''))
    const months = readdirSync(archive)
    expect(months).toEqual([`${new Date(monthAgo).toISOString().slice(0, 7)}.jsonl.gz`])
    expect(statSync(join(archive, months[0])).mode & 0o777).toBe(0o600)
    expect(existsSync(join(journalDir, file))).toBe(false)
    await expect(count(win)).toHaveCount(0)
  } finally {
    await app.close()
  }
})
