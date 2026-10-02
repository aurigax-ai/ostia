import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  type FakeProvider,
  type FakeReply,
  type FakeRequest,
  assistantModelSettings,
  startFakeProvider,
} from './fakeProvider'
import { openWorkspace } from './helpers'

const ORIGINAL = 'one\ntwo\nthree\n'
const EDITED = 'one\nTWO\nthree\n'
const LIST = 'a\nb\nc\nd\ne\nf\ng\nh\n'

let outsideFile = ''

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
  if (req.last.includes('elsewhere')) {
    return {
      toolCalls: [{ name: 'write_file', args: { path: outsideFile, content: 'escaped\n' } }],
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
  outsideFile = join(dataHome, 'userData', 'elsewhere', 'escaped.txt')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
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
    second = await startFakeProvider(() => 'Hello from the second provider.')
  })

  test.afterAll(() => {
    provider.close()
    second.close()
  })

  test('Ask mode shows a proposed edit as a diff, opens it in a diff tab and writes only on Accept', async () => {
    const session = await start(provider)
    const { win, notes } = session
    try {
      await expect(win.getByRole('button', { name: 'Mode: Ask' })).toBeVisible()
      await ask(session, 'shout the second line')
      const card = win.locator('.chat-edit[data-tool="edit_file"]').last()
      await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 15_000 })
      await expect(card.getByRole('status')).toHaveText('Waiting for you')
      await expect(card).toContainText('notes.txt')
      await expect(card).toContainText('+1')
      await expect(card).toContainText('-1')
      await expect(card.locator('[data-diff="del"]')).toHaveText('-two')
      await expect(card.locator('[data-diff="add"]')).toHaveText('+TWO')
      expect(provider.requests.some((r) => r.tools.includes('edit_file'))).toBe(true)
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)

      await card.getByRole('button', { name: 'Open diff' }).click()
      const diff = win.locator('.diff-surface').last()
      await expect(diff.locator('.diff-title')).toContainText('notes.txt', { timeout: 15_000 })
      await expect(diff.locator('.monaco-diff-editor')).toBeVisible()
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)

      await card.getByRole('button', { name: 'Accept' }).click()
      await expect(card).toHaveAttribute('data-state', 'applied', { timeout: 15_000 })
      await expect(card.getByRole('status')).toHaveText('Applied')
      await expect.poll(() => readFileSync(notes, 'utf8')).toBe(EDITED)
      await expect(win.locator('.ask-answer').last()).toContainText('Tool said:', {
        timeout: 15_000,
      })
      await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible()
    } finally {
      await session.app.close()
    }
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
      await expect(card).toContainText('You have unsaved edits in this file')
      expect(readFileSync(notes, 'utf8')).toBe(ORIGINAL)
      await card.getByRole('button', { name: 'Accept' }).click()
      await expect(card).toHaveAttribute('data-state', 'applied', { timeout: 15_000 })
      await expect.poll(() => readFileSync(notes, 'utf8')).toBe(EDITED)
      await fileTab(win).click()
      await expect(win.locator('.editor-disk-bar')).toBeVisible({ timeout: 15_000 })
      await expect(editor).toContainText('MINE one')
      await expect(editor).not.toContainText('TWO')
    } finally {
      await session.app.close()
    }
  })

  test('Write mode still asks before writing outside the workspace folder', async () => {
    const session = await start(provider)
    const { win } = session
    try {
      await chooseMode(win, 'Write')
      await ask(session, 'write it elsewhere')
      const card = win.locator('.chat-edit[data-tool="write_file"]').last()
      await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 15_000 })
      await expect(card).toContainText(
        'Outside the workspace folder, so it waits for you in every mode.',
      )
      await expect(card.locator('[data-diff="add"]')).toHaveText('+escaped')
      expect(existsSync(outsideFile)).toBe(false)
      await card.getByRole('button', { name: 'Reject' }).click()
      await expect(card).toHaveAttribute('data-state', 'rejected', { timeout: 15_000 })
      expect(existsSync(outsideFile)).toBe(false)

      await settled(win)
      await ask(session, 'write it elsewhere after all')
      const again = win.locator('.chat-edit[data-tool="write_file"]').last()
      await expect(again).toHaveAttribute('data-state', 'pending', { timeout: 15_000 })
      await again.getByRole('button', { name: 'Accept' }).click()
      await expect(again).toHaveAttribute('data-state', 'applied', { timeout: 15_000 })
      expect(readFileSync(outsideFile, 'utf8')).toBe('escaped\n')
    } finally {
      await session.app.close()
    }
  })

  test('Write mode edits in two files: review bar, one change reverted, Undo after a restart, and a checkpoint', async () => {
    const session = await start(provider)
    const { win, notes, project, dataHome } = session
    const list = join(project, 'list.txt')
    writeFileSync(list, LIST)
    try {
      await chooseMode(win, 'Write')
      await ask(session, 'tidy both files')
      const bar = win.getByRole('region', { name: 'Edits to review' })
      await expect(bar).toContainText('Edits: 2 · Files: 2', { timeout: 15_000 })
      await settled(win)
      expect(readFileSync(notes, 'utf8')).toBe(EDITED)
      expect(readFileSync(list, 'utf8')).toBe('A\nb\nc\nd\ne\nf\ng\nH\n')

      const listCard = win.getByRole('region', { name: 'Edit to list.txt' })
      await listCard.getByRole('button', { name: 'Reject change 2' }).click()
      await expect(listCard.getByRole('region', { name: /^Change 2/ })).toHaveAttribute(
        'data-decision',
        'rejected',
      )
      await expect.poll(() => readFileSync(list, 'utf8')).toBe('A\nb\nc\nd\ne\nf\ng\nh\n')

      await bar.getByRole('button', { name: 'Next file' }).click()
      await expect(bar).toContainText('2 of 2: list.txt')
      await bar.getByRole('button', { name: 'Accept all' }).click()
      await expect(bar).toHaveCount(0)
      await expect.poll(() => savedChats(dataHome)).toContain('"decisions":["accepted","rejected"]')
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

  test('the composer model menu sends the next question to the picked provider and model, on one row at any width', async () => {
    const session = await start(provider, second)
    const { win, app } = session
    try {
      const firstBefore = provider.requests.length
      await ask(session, 'hello there')
      await expect(win.locator('.ask-answer').last()).toContainText('Hello from the first model.', {
        timeout: 15_000,
      })
      expect(provider.requests.slice(firstBefore).map((r) => r.model)).toEqual(['fake-big'])
      expect(second.requests).toHaveLength(0)
      await settled(win)

      await win.getByRole('button', { name: 'Model: First · fake-big' }).click()
      const options = win.getByRole('menuitemradio')
      await expect(options).toHaveText(['fake-big', 'fake-small', 'other-model'])
      await options.filter({ hasText: 'other-model' }).click()
      const picked = win.getByRole('button', { name: 'Model: Second · other-model' })
      await expect(picked).toBeVisible()

      const firstAfter = provider.requests.length
      await ask(session, 'hello again')
      await expect(win.locator('.ask-answer').last()).toContainText(
        'Hello from the second provider.',
        { timeout: 15_000 },
      )
      expect(second.requests.map((r) => r.model)).toEqual(['other-model'])
      expect(provider.requests.length).toBe(firstAfter)
      await settled(win)

      const controls = [
        win.getByRole('button', { name: 'Tools for this chat' }),
        win.getByRole('button', { name: /^Mode: / }),
        picked,
        win.getByRole('button', { name: 'Send', exact: true }),
      ]
      const row = win.locator('.chat-composer-row').last()
      const layout = async (): Promise<string> => {
        const rowBox = await row.boundingBox()
        const boxes = await Promise.all(controls.map((control) => control.boundingBox()))
        if (!rowBox || boxes.some((box) => box === null)) return 'missing'
        const list = boxes.map((box) => box as NonNullable<typeof box>)
        const centres = list.map((box) => Math.round(box.y + box.height / 2))
        if (Math.max(...centres) - Math.min(...centres) > 2) return 'wrapped'
        const inside = list.every(
          (box) => box.x >= rowBox.x - 1 && box.x + box.width <= rowBox.x + rowBox.width + 1,
        )
        if (!inside) return 'overflowing'
        const apart = list.every(
          (box, index) => index === 0 || box.x >= list[index - 1].x + list[index - 1].width - 1,
        )
        return apart ? 'one row' : 'overlapping'
      }
      for (const width of [1100, 760, 600]) {
        await app.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 700),
          width,
        )
        await expect.poll(layout, { message: `window ${width}px wide` }).toBe('one row')
      }

      await win.getByRole('button', { name: 'New chat' }).click()
      await expect(win.getByRole('button', { name: 'Model: First · fake-big' })).toBeVisible()
      await expect(win.getByRole('button', { name: 'Mode: Ask' })).toBeVisible()
    } finally {
      await session.app.close()
    }
  })
})
