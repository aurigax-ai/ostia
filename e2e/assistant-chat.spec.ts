import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, _electron as electron, expect, test } from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeProvider, type FakeRequest, startFakeProvider } from './fakeProvider'
import { openWorkspace } from './helpers'

const RUN_MARKER = 'pine-ran-from-chat'

function seedAssistant(dataHome: string, url: string, extra: object = {}): void {
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    ...extra,
    extensionSettings: {
      assistant: {
        provider: 'openai-compatible',
        baseUrl: url,
        fastModel: 'fake-small',
        chatModel: 'fake-big',
      },
    },
  })
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

test.describe('assistant chat pane and terminal completion', () => {
  let provider: FakeProvider
  let notes = ''

  test.beforeAll(async () => {
    provider = await startFakeProvider((req: FakeRequest) => {
      if (req.system.includes('autocomplete the command')) {
        const line = req.last.match(/Current line: (.*)$/m)?.[1] ?? ''
        return line.startsWith('echo pine-gh') ? 'echo pine-ghost-ok' : line
      }
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
      await expect(menu).toContainText('openai-compatible · fake-small / fake-big', {
        timeout: 15_000,
      })
      await menu.getByRole('button', { name: /Open chat/ }).click()

      const question = win.getByRole('textbox', { name: 'Your question' }).last()
      await expect(question).toBeVisible({ timeout: 10_000 })
      await question.fill('print a marker for me')
      await question.press('Enter')
      const reply = win.locator('.ask-answer').last()
      await expect(reply.locator('pre')).toContainText(`echo ${RUN_MARKER}`, { timeout: 15_000 })
      expect(provider.requests.some((r) => r.model === 'fake-big' && r.stream)).toBe(true)

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

  test('terminal ghost text is accepted with Tab without running, and stops once turned off in the Assistant menu', async () => {
    const dataHome = freshDataHome()
    seedAssistant(dataHome, provider.url, {
      behavior: { gpuAcceleration: false, inputMode: 'editor' },
    })
    const app = await electron.launch(isolatedLaunch(dataHome))
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      const editor = win.getByRole('textbox', { name: 'Command input' })
      await expect(editor).toBeVisible({ timeout: 15_000 })
      await editor.click()
      await win.keyboard.type('echo pine-gh')
      const ghost = win.locator('[data-ghost="ai"]')
      await expect(ghost).toHaveText('ost-ok', { timeout: 15_000 })
      await win.keyboard.press('Tab')
      await expect(editor).toHaveValue('echo pine-ghost-ok')
      await win.waitForTimeout(500)
      const rows = await win.locator('.xterm-rows').first().innerText()
      expect(rows.split('\n').some((l) => l.trim() === 'pine-ghost-ok')).toBe(false)

      await win.keyboard.press('Control+c')
      await expect(editor).toHaveValue('')
      const menu = await openAssistantMenu(win)
      const toggle = menu.getByRole('switch', { name: 'Terminal completion' })
      await expect(toggle).toBeChecked()
      await toggle.click()
      await expect(toggle).not.toBeChecked()
      await win.keyboard.press('Escape')

      const before = provider.requests.length
      await editor.click()
      await win.keyboard.type('echo pine-gh')
      await win.waitForTimeout(1500)
      await expect(ghost).toHaveCount(0)
      expect(
        provider.requests.slice(before).some((r) => r.system.includes('autocomplete the command')),
      ).toBe(false)
    } finally {
      await app.close()
    }
  })
})
