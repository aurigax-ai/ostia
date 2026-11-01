import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeProvider, startFakeProvider } from './fakeProvider'
import { openWorkspace } from './helpers'
import { type Page, _electron as electron, expect, test } from './test'

const ORIGINAL = 'one\ntwo\nthree\n'
const EDITED = 'one\nTWO\nthree\n'

async function openAgentPane(win: Page): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.keyboard.type('Agent: Open pane')
  await win.getByRole('option', { name: /Agent: Open pane/ }).click()
}

test.describe('agent pane', () => {
  let provider: FakeProvider

  test.beforeAll(async () => {
    provider = await startFakeProvider((req) =>
      req.toolResult !== undefined
        ? 'The second line is now uppercase.'
        : {
            toolCalls: [
              {
                name: 'edit_file',
                args: { path: 'notes.txt', edits: [{ old_text: 'two', new_text: 'TWO' }] },
              },
            ],
          },
    )
  })

  test.afterAll(() => provider.close())

  test('an approved edit lands in the file, the session file is private, and the conversation comes back after a restart', async () => {
    const dataHome = freshDataHome()
    const project = join(dataHome, 'userData', 'project')
    mkdirSync(project, { recursive: true })
    const notes = join(project, 'notes.txt')
    writeFileSync(notes, ORIGINAL)
    seedSettings(dataHome, {
      ...CANVAS_RENDERER_SETTINGS,
      workspaces: { confirmQuit: false, defaultFolder: project },
      agent: {
        providers: [{ id: 'fake', name: 'Fake', baseUrl: provider.url, models: ['fake-model'] }],
      },
    })

    const app = await electron.launch(isolatedLaunch(dataHome))
    try {
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)
      await openAgentPane(win)
      const question = win.getByRole('textbox', { name: 'Your question' }).last()
      await expect(question).toBeVisible({ timeout: 15_000 })
      await question.fill('shout the second line')
      await question.press('Enter')

      const card = win.locator('.chat-edit[data-tool="edit_file"]').last()
      await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 30_000 })
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)
      await card.getByRole('button', { name: 'Accept' }).click()
      await expect(win.getByText('The second line is now uppercase.')).toBeVisible({
        timeout: 30_000,
      })
      expect(readFileSync(notes, 'utf8')).toBe(EDITED)
    } finally {
      await app.close()
    }

    const sessions = join(dataHome, 'userData', 'extension-data', 'agent', 'sessions')
    const files = readdirSync(sessions).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    expect(statSync(join(sessions, files[0])).mode & 0o077).toBe(0)

    const again = await electron.launch(isolatedLaunch(dataHome))
    try {
      const win = await again.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await expect(win.getByText('The second line is now uppercase.')).toBeVisible({
        timeout: 30_000,
      })
      await expect(win.getByText('shout the second line').first()).toBeVisible()
    } finally {
      await again.close()
    }
  })
})
