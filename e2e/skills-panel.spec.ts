import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, quitApp, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, type Page, test } from './test'

test.describe.configure({ timeout: 120_000 })

function rule(id: string, text: string, state: string, extra: object = {}) {
  return {
    id,
    rule: text,
    why: '',
    when: '',
    scope: 'global',
    state,
    origin: 'extraction',
    createdAt: Date.now(),
    ...extra,
  }
}

function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    return guest ? String(await guest.executeJavaScript(code)) : ''
  }, script)
}

async function openPanel(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill('Skill Workshop: Open')
  await waitForPaletteSelection(win, 'Skill Workshop: Open')
  await win.keyboard.press('Enter')
}

const cardButtons = (id: string) =>
  `[...document.querySelectorAll('[data-rule="${id}"] button')].map((b) => b.textContent).join()`

const clickOnCard = (id: string, label: string) =>
  `[...document.querySelectorAll('[data-rule="${id}"] button')].find((b) => b.textContent === ${JSON.stringify(label)})?.click(); 'ok'`

test('the human approves a proposed rule only after resolving its conflict', async () => {
  const dataHome = freshDataHome()
  const dir = join(dataHome, 'userData', 'extension-data', 'skills')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, 'rules.json'),
    JSON.stringify({
      next: 3,
      rules: [
        rule('r1', 'Write no comments in code.', 'active', { origin: 'human', conflicts: ['r2'] }),
        rule('r2', 'Write a comment only where the reason is not obvious.', 'proposed', {
          evidence: [],
          conflicts: ['r1'],
        }),
        rule('r3', 'Prefer plain functions over classes.', 'proposed', { evidence: [] }),
      ],
    }),
    { mode: 0o600 },
  )
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await openPanel(win)
    await expect
      .poll(() => panelEval(app, `document.querySelector('[data-rule="r2"]') ? 'y' : 'n'`), {
        timeout: 30_000,
      })
      .toBe('y')
    await panelEval(app, `document.querySelector('[data-rule="r2"]').click(); 'ok'`)
    await expect
      .poll(() => panelEval(app, `document.querySelector('[data-block="conflict"]') ? 'y' : 'n'`))
      .toBe('y')
    expect(await panelEval(app, cardButtons('r2'))).toBe('Settle')
    expect(
      await panelEval(
        app,
        `[...document.querySelectorAll('[data-pane="view"] button')].some((b) => b.textContent === 'Approve') ? 'shown' : 'hidden'`,
      ),
    ).toBe('hidden')
    expect(await panelEval(app, cardButtons('r3'))).toBe('Approve,Dismiss')
    await expect.poll(() => panelEval(app, clickOnCard('r3', 'Approve'))).toBe('ok')
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')).rules.find(
            (r: { id: string }) => r.id === 'r3',
          ).state,
      )
      .toBe('active')
    const stored = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8')).rules
    expect(stored.find((r: { id: string }) => r.id === 'r2').state).toBe('proposed')
    const toolbar = win.locator('#right-panel')
    await toolbar.getByRole('button', { name: 'Add a rule' }).click()
    await expect
      .poll(() => panelEval(app, `document.querySelector('[data-pane="form"]') ? 'form' : 'none'`))
      .toBe('form')
    await expect(toolbar.getByRole('button', { name: 'Back' })).toBeFocused()
    await toolbar.getByRole('button', { name: 'Back' }).click()
    await expect
      .poll(() => panelEval(app, `document.querySelector('[data-pane="form"]') ? 'form' : 'none'`))
      .toBe('none')
    await expect(toolbar.getByRole('button', { name: 'Add a rule' })).toBeFocused()
  } finally {
    await quitApp(app)
  }
})
