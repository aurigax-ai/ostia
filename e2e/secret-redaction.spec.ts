import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE } from '../test/fixtures/secrets/samples'
import { freshDataHome } from './dataHome'
import { launchWindow, openWorkspace, quitApp } from './helpers'
import { expect, type Page, test } from './test'

const TOKEN = FAKE.githubClassic
const MARK = '[redacted:github]'

async function typeInTerminal(win: Page, line: string): Promise<void> {
  await win.locator('.ghostty-host').first().click()
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.matches('.ghostty-host, .ghostty-host *') ?? false,
      ),
    )
    .toBe(true)
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

test('the live terminal keeps a secret, the saved scrollback and the restored history do not', async () => {
  const dataHome = freshDataHome()
  const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')

  const first = await launchWindow(dataHome)
  try {
    await openWorkspace(first.win)
    await typeInTerminal(first.win, `echo key=${TOKEN} done`)
    await expect(first.win.locator('.terminal-text').first()).toContainText(`key=${TOKEN} done`, {
      timeout: 15_000,
    })
    await expect
      .poll(
        () => existsSync(scrollbackFile) && readFileSync(scrollbackFile, 'utf8').includes(MARK),
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
    await typeInTerminal(first.win, `echo last=${TOKEN}`)
    await expect(first.win.locator('.terminal-text').first()).toContainText(`last=${TOKEN}`, {
      timeout: 15_000,
    })
  } finally {
    await quitApp(first.app)
  }

  const saved = readFileSync(scrollbackFile, 'utf8')
  expect(saved).not.toContain(TOKEN)
  expect(saved).toContain(`key=${MARK} done`)
  expect(saved).toContain(`last=${MARK}`)

  const second = await launchWindow(dataHome)
  try {
    await expect(second.win.locator('.workzone')).toContainText(`last=${MARK}`, {
      timeout: 15_000,
    })
    await expect(second.win.locator('.workzone')).not.toContainText(TOKEN)
  } finally {
    await quitApp(second.app)
  }
})
