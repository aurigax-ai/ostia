import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  type FakeProvider,
  type FakeRequest,
  fakeAssistantSettings,
  startFakeProvider,
} from './fakeProvider'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const RUN_MARKER = 'ostia-ran-from-chat'

function seedAssistant(dataHome: string, url: string): void {
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, assistant: fakeAssistantSettings(url) })
}

async function openAssistantMenu(win: Page) {
  await win
    .locator('header.topbar')
    .getByRole('button', { name: /^Assistant/ })
    .click()
  const menu = win.getByRole('dialog', { name: 'Assistant' })
  await expect(menu).toBeVisible()
  return menu
}

test.describe('assistant chat pane', () => {
  let provider: FakeProvider
  let notes = ''

  test.beforeAll(async () => {
    provider = await startFakeProvider((req: FakeRequest) => {
      if (req.last.includes('marker')) {
        return `Run this:\n\n\`\`\`bash\necho ${RUN_MARKER}\n\`\`\`\n`
      }
      if (req.last.includes('notes')) return `The line is in ${notes}:3 near the top.`
      return 'Hello from the fake model.'
    })
  })

  test.afterAll(() => provider.close())

  test('the top-bar button opens the chat pane, a shell block runs in a new terminal, a path opens the editor, and the session survives a restart', async () => {
    const dataHome = freshDataHome()
    seedAssistant(dataHome, provider.url)
    const project = join(dataHome, 'userData', 'project')
    mkdirSync(project, { recursive: true })
    notes = join(project, 'notes.txt')
    writeFileSync(notes, 'one\ntwo\nthree marker line\nfour\n')
    let app = await electron.launch(isolatedLaunch(dataHome))
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)

      const menu = await openAssistantMenu(win)
      await expect(menu).toContainText('Fake · fake-big', { timeout: 15_000 })
      await expect(menu).toContainText('Fake · fake-small')
      await win.keyboard.press('Escape')
      await win
        .locator('header.topbar')
        .getByRole('button', { name: /^Open chat/ })
        .click()

      const question = win.getByRole('combobox', { name: 'Your question' }).last()
      await expect(question).toBeVisible({ timeout: 10_000 })
      await question.fill('print a marker for me')
      await question.press('Enter')
      const reply = win.locator('.ask-answer').last()
      await expect(reply.locator('pre')).toContainText(`echo ${RUN_MARKER}`, { timeout: 15_000 })

      const terminals = await win.locator('.xterm').count()
      await reply.locator('pre').hover()
      await reply.getByRole('button', { name: 'Run in new terminal' }).click()
      await win.getByRole('button', { name: 'Run', exact: true }).click()
      await expect(win.locator('.xterm')).toHaveCount(terminals + 1, { timeout: 15_000 })
      await expect
        .poll(
          async () => {
            const texts = await win.locator('.xterm-rows').allInnerTexts()
            return texts.some((t) => t.split('\n').some((l) => l.trim() === RUN_MARKER))
          },
          { timeout: 15_000 },
        )
        .toBe(true)

      await question.fill('where are the notes')
      await question.press('Enter')
      const link = win.locator('.ask-answer').last().locator('.chat-file-link')
      await expect(link).toContainText('notes.txt:3', { timeout: 15_000 })
      await link.click()
      await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
      await expect(win.locator('.monaco-editor .view-lines').first()).toContainText(
        'three marker line',
      )
      await expect(win.getByText('print a marker for me').first()).toBeVisible()
    } finally {
      await app.close()
    }

    app = await electron.launch(isolatedLaunch(dataHome))
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await expect(win.getByText('print a marker for me').first()).toBeVisible({ timeout: 15_000 })
    } finally {
      await app.close()
    }
  })
})
