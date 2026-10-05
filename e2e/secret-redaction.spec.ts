import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeProvider, fakeAssistantSettings, startFakeProvider } from './fakeProvider'
import { openWorkspace } from './helpers'

const TOKEN = ['ghp_', 'wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx'].join('')
const MARK = '[redacted:github]'

async function launch(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function typeInTerminal(win: Page, line: string): Promise<void> {
  await win.locator('.xterm').first().click()
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

test('the live terminal keeps a secret, the saved scrollback and the restored history do not', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS })
  const scrollbackFile = join(dataHome, 'ostia', 'scrollback.json')

  const first = await launch(dataHome)
  try {
    await openWorkspace(first.win)
    await typeInTerminal(first.win, `echo key=${TOKEN} done`)
    await expect(first.win.locator('.xterm-rows').first()).toContainText(`key=${TOKEN} done`, {
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
    await expect(first.win.locator('.xterm-rows').first()).toContainText(`last=${TOKEN}`, {
      timeout: 15_000,
    })
  } finally {
    await quit(first.app)
  }

  const saved = readFileSync(scrollbackFile, 'utf8')
  expect(saved).not.toContain(TOKEN)
  expect(saved).toContain(`key=${MARK} done`)
  expect(saved).toContain(`last=${MARK}`)

  const second = await launch(dataHome)
  try {
    await expect(second.win.locator('.workzone')).toContainText(`last=${MARK}`, {
      timeout: 15_000,
    })
    await expect(second.win.locator('.workzone')).not.toContainText(TOKEN)
  } finally {
    await quit(second.app)
  }
})

test.describe('chat with a provider', () => {
  let provider: FakeProvider

  test.beforeAll(async () => {
    provider = await startFakeProvider(() => 'That key is refused because it expired.')
  })

  test.afterAll(() => provider.close())

  test('the provider gets the question with the secret redacted, the chat says so, and the saved session has no secret', async () => {
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      assistant: fakeAssistantSettings(provider.url),
    })
    const { app, win } = await launch(dataHome)
    try {
      await openWorkspace(win)
      await win
        .locator('header.topbar')
        .getByRole('button', { name: /^Open chat/ })
        .click()
      const question = win.getByRole('combobox', { name: 'Your question' }).last()
      await expect(question).toBeVisible({ timeout: 15_000 })
      await question.fill(`why is ${TOKEN} refused?`)
      await expect(win.getByTestId('chat-redaction-count')).toHaveText(
        '1 secret will be redacted',
        {
          timeout: 15_000,
        },
      )
      await question.press('Enter')
      await expect(win.locator('.ask-answer').last()).toContainText('it expired', {
        timeout: 15_000,
      })

      const sent = provider.requests.filter((r) => r.last.includes('refused?'))
      expect(sent.length).toBeGreaterThan(0)
      for (const request of sent) {
        expect(request.last).toContain(`why is ${MARK} refused?`)
        expect(request.last).not.toContain(TOKEN)
      }
      const asked = win.locator('.chat-message').filter({ hasText: 'refused?' }).first()
      await expect(asked).toContainText(`why is ${MARK} refused?`)
      await expect(asked).toContainText('1 secret redacted')

      const sessions = join(dataHome, 'ostia', 'chat-sessions')
      await expect
        .poll(() => (existsSync(sessions) ? readdirSync(sessions).length : 0), { timeout: 15_000 })
        .toBeGreaterThan(0)
      for (const name of readdirSync(sessions)) {
        const file = readFileSync(join(sessions, name), 'utf8')
        expect(file).not.toContain(TOKEN)
        expect(file).toContain(MARK)
      }
    } finally {
      await app.close()
    }
  })
})
