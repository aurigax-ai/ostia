import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { PRODUCT_NAME } from '../src/shared/product'
import { installFakeLanguageExtension } from '../test/fixtures/lsp/installFakeExtension'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyWorkspace, openWorkspace } from './helpers'

const FAKE_SYSTEM_BIN = resolve(__dirname, '../test/fixtures/system/bin')

interface Launched {
  app: ElectronApplication
  win: Page
  home: string
  project: string
}

async function launch(files: Record<string, string>, fixture = 'fake-lang'): Promise<Launched> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(home, 'secret.txt'), 'TOP-SECRET\n')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
  const options = isolatedLaunch(dataHome)
  installFakeLanguageExtension(
    join(options.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions'),
    fixture,
  )
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home, PATH: `${FAKE_SYSTEM_BIN}:${process.env.PATH}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, home, project }
}

async function approveFakeLanguage(win: Page): Promise<void> {
  const approval = win.getByRole('dialog').filter({ hasText: 'Fake language' })
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(approval.getByRole('list', { name: 'Language servers' })).toContainText(
    'Runs server/fake-server.cjs',
  )
  await approval.getByRole('button', { name: 'Approve and enable' }).click()
  await expect(approval).toBeHidden()
}

async function openFile(win: Page, name: string): Promise<Locator> {
  const files = win.locator('.file-row')
  if ((await files.count()) === 0) {
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  }
  await files.filter({ hasText: name }).click()
  const editor = win.locator('.monaco-editor:visible').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  return editor
}

async function openLanguages(win: Page): Promise<Locator> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Languages', exact: true }).click()
  return settings
}

function fakeRow(settings: Locator): Locator {
  return settings.getByRole('listitem', { name: 'Fake server' })
}

function starts(project: string): number {
  const file = join(project, '.fake-lsp-record.jsonl')
  if (!existsSync(file)) return 0
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"$start"')).length
}

function recorded(project: string): string[] {
  const file = join(project, '.fake-lsp-record.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

async function hoverText(win: Page, editor: Locator, text: string): Promise<Locator> {
  const target = editor.locator('.view-line span span').filter({ hasText: text }).first()
  await target.hover({ position: { x: 4, y: 8 } })
  const hover = win.locator('.monaco-hover:visible')
  await expect(hover).toBeVisible({ timeout: 10_000 })
  return hover
}

test('an extension’s language server gives the editor a diagnostic, hover and completion', async () => {
  const { app, win, project } = await launch({ 'notes.txt': 'greeting ERROR here\nsecond line\n' })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    const editor = await openFile(win, 'notes.txt')

    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })
    const hover = await hoverText(win, editor, 'greeting')
    await expect(hover).toContainText('fake hover: greeting')

    await editor.locator('.view-line').nth(1).click()
    await win.keyboard.press('End')
    await win.keyboard.type(' fak')
    await win.keyboard.press('Control+Space')
    const suggest = win.locator('.suggest-widget:visible')
    await expect(suggest).toContainText('fakeAlpha', { timeout: 10_000 })
    await suggest.locator('.monaco-list-row').filter({ hasText: 'fakeEdit' }).click()
    await expect(editor.locator('.view-lines')).toContainText('imported by fake')
    await expect(editor.locator('.view-lines')).toContainText('second line fakeEdited')

    const settings = await openLanguages(win)
    const row = fakeRow(settings)
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
    await expect(row).toContainText('Fake language · plaintext')
    expect(starts(project)).toBe(1)
  } finally {
    await app.close()
  }
})

test('a missing program is offered for install, with the exact command shown before anything runs', async () => {
  const { app, win } = await launch({ 'notes.txt': 'plain\n' })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    await app.evaluate(({ dialog }) => {
      const g = globalThis as { pineE2eAsked?: unknown[] }
      g.pineE2eAsked = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        g.pineE2eAsked?.push(args.length > 1 ? args[1] : args[0])
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const settings = await openLanguages(win)
    const row = settings.getByRole('listitem', { name: 'Absent server' })
    await expect(row.getByTestId('language-server-status')).toHaveText(
      'Program missing: pine-absent-lsp',
    )
    await row.getByRole('button', { name: 'Install Absent server' }).click()
    await expect
      .poll(
        () =>
          app.evaluate(
            () =>
              JSON.stringify((globalThis as { pineE2eAsked?: unknown[] }).pineE2eAsked ?? []) ?? '',
          ),
        { timeout: 15_000 },
      )
      .toContain('pine-absent-lsp')
    await expect(win.locator('.xterm')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('switching a server off stops its process, and Restart starts a fresh one', async () => {
  const { app, win, project } = await launch({ 'notes.txt': 'an ERROR\n' })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    const editor = await openFile(win, 'notes.txt')
    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })

    const settings = await openLanguages(win)
    const row = fakeRow(settings)
    await row.getByRole('button', { name: 'Restart Fake server' }).click()
    await expect.poll(() => starts(project), { timeout: 15_000 }).toBe(2)
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)', {
      timeout: 15_000,
    })
    const lifecycle = [
      '$start',
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'shutdown',
      'exit',
    ]
    expect(
      recorded(project)
        .filter((method) => lifecycle.includes(method))
        .slice(0, 7),
    ).toEqual([
      '$start',
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'shutdown',
      'exit',
      '$start',
    ])

    await row.getByRole('switch', { name: 'Enable Fake server' }).click()
    await expect(row.getByTestId('language-server-status')).toHaveText('Off', { timeout: 15_000 })
    await expect
      .poll(() => recorded(project).filter((method) => method === 'exit').length, {
        timeout: 15_000,
      })
      .toBe(2)

    await row.getByRole('button', { name: 'Show the log of Fake server' }).click()
    const log = win.getByRole('dialog').filter({ hasText: 'Log of Fake server' })
    await expect(log).toContainText('Stopping: turned off')
    await expect(log).toContainText('Initialized pine-fake-lsp 1.0.0')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
    await expect(win.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(0)
    expect(starts(project)).toBe(2)
  } finally {
    await app.close()
  }
})

test('a crashing server is restarted five times, then reported as crashed until the human restarts it', async () => {
  test.setTimeout(120_000)
  const { app, win, project } = await launch({ 'boom.txt': 'CRASH on open\n' })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    await openFile(win, 'boom.txt')
    const settings = await openLanguages(win)
    const row = fakeRow(settings)
    await expect(row.getByTestId('language-server-status')).toHaveText('Crashed', {
      timeout: 60_000,
    })
    expect(starts(project)).toBe(6)

    writeFileSync(join(project, 'boom.txt'), 'calm now\n')
    await row.getByRole('button', { name: 'Restart Fake server' }).click()
    await expect.poll(() => starts(project), { timeout: 15_000 }).toBe(7)
  } finally {
    await app.close()
  }
})

test('in a sandboxed workspace the server runs wrapped and cannot read a file under home', async () => {
  test.setTimeout(90_000)
  const { app, win, home, project } = await launch({})
  writeFileSync(
    join(project, 'probe.txt'),
    `READ ${join(home, 'secret.txt')}\nREAD ${join(project, 'inside.txt')}\n`,
  )
  writeFileSync(join(project, 'inside.txt'), 'in the project\n')
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    await win.locator('.rail-row').first().click({ button: 'right' })
    await win.getByRole('menuitemcheckbox', { name: 'Sandbox' }).click()
    const editor = await openFile(win, 'probe.txt')
    await expect(editor.locator('.squiggly-info')).toHaveCount(2, { timeout: 30_000 })
    const denied = await hoverText(win, editor, 'secret.txt')
    await expect(denied).toContainText('read failed')
    await win.keyboard.press('Escape')

    const settings = await openLanguages(win)
    await fakeRow(settings).getByRole('button', { name: 'Show the log of Fake server' }).click()
    await expect(win.getByRole('dialog').filter({ hasText: 'Log of Fake server' })).toContainText(
      'Started in the sandbox',
    )
  } finally {
    await app.close()
  }
})

test('two windows showing the same folder each get their own server and their own diagnostics', async () => {
  test.setTimeout(90_000)
  const { app, win, project } = await launch({
    'one.txt': 'first ERROR\n',
    'two.txt': 'second ERROR\nand another ERROR\n',
  })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    const first = await openFile(win, 'one.txt')
    await expect(first.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })

    await win.locator('.topbar').getByRole('button', { name: 'New workspace' }).click()
    await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await win.locator('.rail-row').nth(1).click({ button: 'right' })
    const [detached] = await Promise.all([
      app.waitForEvent('window'),
      win.getByRole('menuitem', { name: 'Move to new window' }).click(),
    ])
    await detached.waitForLoadState('domcontentloaded')
    await expect(detached.locator('.xterm-rows').first()).toContainText(PROMPT, {
      timeout: 15_000,
    })
    await detached.locator('.xterm').first().click()
    await detached.keyboard.type('pine open two.txt')
    await detached.keyboard.press('Enter')
    const second = detached.locator('.monaco-editor:visible').first()
    await expect(second).toBeVisible({ timeout: 15_000 })
    await expect(second.locator('.squiggly-error')).toHaveCount(2, { timeout: 20_000 })
    await expect(win.locator('.monaco-editor:visible .squiggly-error')).toHaveCount(1)
    expect(starts(project)).toBe(2)
  } finally {
    await app.close()
  }
})

test('rename, quick fix, signature help, inlay hints and semantic colours work in the editor', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch({
    'rich.txt': [
      'fn alpha uses ERROR and alpha',
      'let count = fakeCall(first, second)',
      'KEYWORD plain',
      '',
    ].join('\n'),
  })
  try {
    await approveFakeLanguage(win)
    await openWorkspace(win)
    const editor = await openFile(win, 'rich.txt')
    const lines = editor.locator('.view-lines')
    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })

    await expect(lines).toContainText('count: fake', { timeout: 15_000 })
    const token = (text: RegExp): Locator =>
      editor.locator('.view-line span span').filter({ hasText: text }).first()
    await expect(token(/^KEYWORD$/)).toBeVisible({ timeout: 15_000 })
    expect(await token(/^KEYWORD$/).getAttribute('class')).not.toBe(
      await token(/plain/).getAttribute('class'),
    )

    await editor
      .locator('.view-line')
      .first()
      .click({ position: { x: 40, y: 8 } })
    await win.keyboard.press('F2')
    const rename = win.locator('.rename-box input')
    await expect(rename).toBeVisible({ timeout: 10_000 })
    await expect(rename).toHaveValue('alpha')
    await rename.fill('beta')
    await win.keyboard.press('Enter')
    await expect(lines).toContainText('fn beta uses ERROR and beta', { timeout: 10_000 })

    await editor.locator('.squiggly-error').hover({ force: true })
    await editor.locator('.squiggly-error').click({ force: true })
    await win.keyboard.press('Control+.')
    const fix = win.locator('.action-widget').getByText('Replace ERROR with FIXED')
    await expect(fix).toBeVisible({ timeout: 10_000 })
    await win.keyboard.press('Enter')
    await expect(lines).toContainText('fn beta uses FIXED and beta', { timeout: 10_000 })
    await expect(editor.locator('.squiggly-error')).toHaveCount(0)

    await editor.locator('.view-line').nth(1).click()
    await win.keyboard.press('End')
    await win.keyboard.press('ArrowLeft')
    await win.keyboard.press('Control+Shift+Space')
    await expect(win.locator('.parameter-hints-widget')).toContainText(
      'fakeCall(first: string, second: number)',
      { timeout: 10_000 },
    )
  } finally {
    await app.close()
  }
})

test('an extension adds an editor language: its grammar colours the file and its server is started for it', async () => {
  const { app, win } = await launch(
    { 'demo.fake': 'fn alpha KEYWORD\nplain ERROR here\n', Fakefile: 'let beta\n' },
    'fake-grammar',
  )
  try {
    const approval = win.getByRole('dialog').filter({ hasText: 'Fake grammar' })
    await expect(approval).toBeVisible({ timeout: 15_000 })
    await approval.getByRole('button', { name: 'Approve and enable' }).click()
    await expect(approval).toBeHidden()
    await openWorkspace(win)

    const editor = await openFile(win, 'demo.fake')
    await expect(win.locator('.editor-host:visible')).toHaveAttribute('data-mode-id', 'fakelang', {
      timeout: 15_000,
    })
    const token = (text: RegExp): Locator =>
      editor.locator('.view-line span span').filter({ hasText: text }).first()
    const classOf = (text: RegExp): Promise<string | null> =>
      token(text).getAttribute('class', { timeout: 5_000 })
    await expect(token(/^fn$/)).toBeVisible({ timeout: 15_000 })
    expect(await classOf(/^fn$/)).toBe(await classOf(/^KEYWORD$/))
    expect(await classOf(/^fn$/)).not.toBe(await classOf(/^alpha$/))
    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })
    const hover = await hoverText(win, editor, 'fn')
    await expect(hover).toContainText('fake hover: fn')

    const byName = await openFile(win, 'Fakefile')
    await expect(
      byName.locator('.view-line span span').filter({ hasText: /^let$/ }).first(),
    ).toBeVisible({ timeout: 15_000 })

    const settings = await openLanguages(win)
    const row = settings.getByRole('listitem', { name: 'Fake grammar server' })
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
    await expect(row).toContainText('fakelang')
  } finally {
    await app.close()
  }
})
