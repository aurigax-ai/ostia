import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  assistantModelSettings,
  type FakeProvider,
  type FakeReply,
  type FakeRequest,
  startFakeProvider,
} from './fakeProvider'
import { openWorkspace } from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from './test'

const ORIGINAL = 'one\ntwo\nthree\n'
const EDITED = 'one\nTWO\nthree\n'
const LIST = 'a\nb\nc\nd\ne\nf\ng\nh\n'

function editAnswer(req: FakeRequest): FakeReply {
  if (req.toolResult !== undefined) return `Tool said: ${req.toolResult.slice(0, 120)}`
  if (req.last.includes('shout')) {
    return {
      toolCalls: [
        {
          name: 'edit_file',
          args: { path: 'notes.txt', edits: [{ old_text: 'two', new_text: 'TWO' }] },
        },
      ],
    }
  }
  if (req.last.includes('tidy both')) {
    return {
      toolCalls: [
        {
          name: 'edit_file',
          args: { path: 'notes.txt', edits: [{ old_text: 'two', new_text: 'TWO' }] },
        },
        {
          name: 'edit_file',
          args: {
            path: 'list.txt',
            edits: [
              { old_text: 'a\n', new_text: 'A\n' },
              { old_text: 'h\n', new_text: 'H\n' },
            ],
          },
        },
      ],
    }
  }
  return 'Hello from the first model.'
}

function savedChats(dataHome: string): string {
  return readdirSync(dataHome, { recursive: true, encoding: 'utf8' })
    .filter((name) => /chat-sessions\/[^/]+\.json$/.test(name))
    .map((name) => readFileSync(join(dataHome, name), 'utf8'))
    .join('\n')
}

interface Session {
  app: ElectronApplication
  win: Page
  dataHome: string
  project: string
  notes: string
  question: Locator
}

async function start(first: FakeProvider, second?: FakeProvider): Promise<Session> {
  const dataHome = freshDataHome()
  const project = join(dataHome, 'userData', 'project')
  mkdirSync(project, { recursive: true })
  const notes = join(project, 'notes.txt')
  writeFileSync(notes, ORIGINAL)
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    workspaces: { confirmQuit: false, defaultFolder: project },
    assistant: assistantModelSettings(
      [
        { id: 'first', name: 'First', url: first.url, models: ['fake-big', 'fake-small'] },
        ...(second
          ? [{ id: 'second', name: 'Second', url: second.url, models: ['other-model'] }]
          : []),
      ],
      { provider: 'first', model: 'fake-small' },
      { provider: 'first', model: 'fake-big' },
    ),
  })
  const app = await electron.launch(isolatedLaunch(dataHome))
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await win
    .locator('header.topbar')
    .getByRole('button', { name: /^Assistant/ })
    .click()
  await expect(win.getByRole('dialog', { name: 'Assistant' })).toContainText('First · fake-big', {
    timeout: 15_000,
  })
  await win.keyboard.press('Escape')
  await win
    .locator('header.topbar')
    .getByRole('button', { name: /^Open chat/ })
    .click()
  const question = win.getByRole('combobox', { name: 'Your question' }).last()
  await expect(question).toBeVisible({ timeout: 10_000 })
  return { app, win, dataHome, project, notes, question }
}

async function ask(session: Session, text: string): Promise<void> {
  await session.question.fill(text)
  await session.question.press('Enter')
}

async function settled(win: Page): Promise<void> {
  await expect(win.locator('.ask-answer').last()).toHaveAttribute('aria-busy', 'false', {
    timeout: 15_000,
  })
}

function chatTab(win: Page): Locator {
  return win.getByRole('tab', { name: /shout the second line/ })
}

function fileTab(win: Page): Locator {
  return win.getByRole('tab', { name: /notes\.txt/ })
}

async function chooseMode(win: Page, mode: 'Ask' | 'Write'): Promise<void> {
  await win.getByRole('button', { name: /^Mode: / }).click()
  await win.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click()
  await expect(win.getByRole('button', { name: `Mode: ${mode}` })).toBeVisible()
}

test.describe('chat code editing', () => {
  let provider: FakeProvider
  let second: FakeProvider

  test.beforeAll(async () => {
    provider = await startFakeProvider(editAnswer)
    second = await startFakeProvider(() => 'unused')
  })

  test.afterAll(() => {
    provider.close()
    second.close()
  })

  test('Write mode applies an edit inside the workspace without asking, the open editor follows, and Undo restores the file', async () => {
    const session = await start(provider)
    const { win, notes } = session
    try {
      await chooseMode(win, 'Write')
      await ask(session, 'shout the second line')
      const card = win.locator('.chat-edit[data-tool="edit_file"]').last()
      await expect(card).toHaveAttribute('data-state', 'auto', { timeout: 15_000 })
      await expect(card.getByRole('status')).toHaveText('Applied automatically')
      await expect(win.locator('.chat-edit[data-state="pending"]')).toHaveCount(0)
      expect(readFileSync(notes, 'utf8')).toBe(EDITED)
      await settled(win)

      await card.getByRole('button', { name: 'notes.txt', exact: true }).click()
      const editor = win.locator('.monaco-editor .view-lines').first()
      await expect(editor).toContainText('TWO', { timeout: 15_000 })

      await chatTab(win).click()
      await card.getByRole('button', { name: 'Undo' }).click()
      await expect(card).toHaveAttribute('data-state', 'undone', { timeout: 15_000 })
      await expect(card.getByRole('status')).toHaveText('Undone')
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)
      await fileTab(win).click()
      await expect(editor).toContainText('two', { timeout: 15_000 })
      await expect(editor).not.toContainText('TWO')
    } finally {
      await session.app.close()
    }
  })

  test('Write mode still asks for a file with unsaved edits and never overwrites what the human typed', async () => {
    const session = await start(provider)
    const { win, notes } = session
    try {
      await chooseMode(win, 'Write')
      await ask(session, 'shout the second line')
      const first = win.locator('.chat-edit[data-tool="edit_file"]').last()
      await expect(first).toHaveAttribute('data-state', 'auto', { timeout: 15_000 })
      await settled(win)
      await first.getByRole('button', { name: 'notes.txt', exact: true }).click()
      const editor = win.locator('.monaco-editor .view-lines').first()
      await expect(editor).toContainText('TWO', { timeout: 15_000 })
      await chatTab(win).click()
      await first.getByRole('button', { name: 'Undo' }).click()
      await expect(first).toHaveAttribute('data-state', 'undone', { timeout: 15_000 })
      await fileTab(win).click()
      await expect(editor).toContainText('two', { timeout: 15_000 })

      await editor.click()
      await win.keyboard.press('Control+Home')
      await win.keyboard.type('MINE ')
      await expect(editor).toContainText('MINE one')

      await chatTab(win).click()
      await ask(session, 'shout the second line again')
      const card = win.locator('.chat-edit[data-tool="edit_file"]').last()
      await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 15_000 })
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)
      await card.getByRole('button', { name: 'Accept' }).click()
      await expect(card).toHaveAttribute('data-state', 'applied', { timeout: 15_000 })
      await expect.poll(() => readFileSync(notes, 'utf8')).toBe(EDITED)
      await fileTab(win).click()
      await expect(win.getByTestId('editor-disk-bar')).toBeVisible({ timeout: 15_000 })
      await expect(editor).toContainText('MINE one')
      await expect(editor).not.toContainText('TWO')
    } finally {
      await session.app.close()
    }
  })

  test('Write mode edits in two files: Undo after a restart, and a checkpoint', async () => {
    const session = await start(provider)
    const { win, notes, project, dataHome } = session
    const list = join(project, 'list.txt')
    writeFileSync(list, LIST)
    try {
      await chooseMode(win, 'Write')
      await ask(session, 'tidy both files')
      await settled(win)
      expect(readFileSync(notes, 'utf8')).toBe(EDITED)
      expect(readFileSync(list, 'utf8')).toBe('A\nb\nc\nd\ne\nf\ng\nH\n')
      await expect
        .poll(() => savedChats(dataHome))
        .toContain(`"after":${JSON.stringify('A\nb\nc\nd\ne\nf\ng\nH\n')}`)
    } finally {
      await session.app.close()
    }

    const app = await electron.launch(isolatedLaunch(dataHome))
    try {
      const again = await app.firstWindow()
      await again.waitForLoadState('domcontentloaded')
      const notesCard = again.getByRole('region', { name: 'Edit to notes.txt' })
      await expect(notesCard).toBeVisible({ timeout: 15_000 })
      await notesCard.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(notesCard).toHaveAttribute('data-state', 'undone', { timeout: 15_000 })
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)

      await again.getByRole('button', { name: 'Restore files to before this message' }).click()
      const dialog = again.getByRole('dialog', { name: 'Restore files to before this message?' })
      await expect(dialog.getByRole('list', { name: 'These go back:' })).toContainText('list.txt')
      await expect(dialog).not.toContainText('notes.txt')
      await dialog.getByRole('button', { name: 'Restore files (1)' }).click()
      await expect(dialog).toHaveCount(0)
      expect(readFileSync(list, 'utf8')).toBe(LIST)
      await expect(
        again.getByRole('region', { name: 'Edit to list.txt' }).getByRole('status'),
      ).toHaveText('Undone')
    } finally {
      await app.close()
    }
  })
})
