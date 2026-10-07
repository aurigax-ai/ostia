import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../src/shared/product'
import { installFakeLanguageExtension } from '../test/fixtures/lsp/installFakeExtension'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, hoverInEditor, openWorkspace } from './helpers'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'

const MARKETPLACE = resolve(__dirname, '../out/marketplace/extensions')

interface Launched {
  app: ElectronApplication
  win: Page
  project: string
  settingsFile: string
}

async function launch(
  files: Record<string, string>,
  install: (extensionsDir: string) => void,
  settings: object = {},
): Promise<Launched> {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text)
  const settingsFile = join(dataHome, 'userData', 'settings.json')
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
    ...settings,
  })
  const options = isolatedLaunch(dataHome)
  install(join(options.env.XDG_CONFIG_HOME, PRODUCT_NAME, 'extensions'))
  const app = await electron.launch({ ...options, env: { ...options.env, HOME: home } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, project, settingsFile }
}

function fromMarketplace(id: string): (extensionsDir: string) => void {
  return (extensionsDir) =>
    cpSync(join(MARKETPLACE, id), join(extensionsDir, id), { recursive: true })
}

async function approve(win: Page, name: string, command: string): Promise<void> {
  const approval = win.getByRole('dialog').filter({ hasText: name })
  await expect(approval).toBeVisible({ timeout: 15_000 })
  await expect(approval.getByRole('list', { name: 'Language servers' })).toContainText(command)
  await approval.getByRole('button', { name: 'Approve and enable' }).click()
  await expect(approval).toBeHidden()
}

async function openFile(win: Page, name: string): Promise<Locator> {
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
  await win.locator('.file-row').filter({ hasText: name }).click()
  const editor = win.locator('.monaco-editor:visible').first()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  return editor
}

async function hoverOn(
  win: Page,
  target: Locator,
  position?: { x: number; y: number },
): Promise<Locator> {
  await win.mouse.move(2, 2)
  await win.keyboard.press('Escape')
  await expect(win.locator('.monaco-hover:visible')).toHaveCount(0)
  await expect(target).toBeInViewport({ ratio: 1 })
  await hoverInEditor(win, target, position)
  const hover = win.locator('.monaco-hover:visible')
  await expect(hover).toBeVisible({ timeout: 15_000 })
  return hover
}

async function serverRow(win: Page, name: string): Promise<Locator> {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Languages', exact: true }).click()
  return settings.getByRole('listitem', { name })
}

const TS_SOURCE = [
  'export function greet(name: string): string {',
  '  return `hi ${name}`',
  '}',
  "export const count: number = 'three'",
  '',
].join('\n')

test('the TypeScript extension’s bundled server checks a .ts file; without it the file is only highlighted', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(
    {
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
      'main.ts': TS_SOURCE,
    },
    fromMarketplace('lsp-typescript'),
  )
  try {
    await approve(win, 'TypeScript and JavaScript', 'server/typescript-language-server/lib/cli.mjs')
    await openWorkspace(win)
    const editor = await openFile(win, 'main.ts')

    await expect
      .poll(
        async () => {
          await win.keyboard.press('Escape')
          const hover = await hoverOn(win, editor.locator('.squiggly-error').first())
          return hover.innerText()
        },
        { timeout: 60_000 },
      )
      .toContain('typescript(2322)')
    await expect(editor.locator('.squiggly-error')).toHaveCount(1)
    const diagnostic = win.locator('.monaco-hover:visible')
    await expect(diagnostic).toContainText("Type 'string' is not assignable to type 'number'.")
    await win.keyboard.press('Escape')

    const signature = await hoverOn(
      win,
      editor
        .locator('.view-line span span')
        .filter({ hasText: /^greet$/ })
        .first(),
    )
    await expect(signature).toContainText('function greet(name: string): string')
    await win.keyboard.press('Escape')

    const row = await serverRow(win, 'typescript-language-server')
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
    await expect(row).toContainText('Bundled')
    await row.getByRole('button', { name: 'Show the log of typescript-language-server' }).click()
    await expect(win.getByRole('dialog').filter({ hasText: 'Log of' })).toContainText(
      'Started (pid',
    )
    await win.keyboard.press('Escape')

    await row.getByRole('switch', { name: 'Enable typescript-language-server' }).click()
    await expect(row.getByTestId('language-server-status')).toHaveText('Off', { timeout: 15_000 })
    await win.keyboard.press('Escape')
    const plain = win.locator('.monaco-editor:visible').first()
    await expect(plain.locator('.squiggly-error')).toHaveCount(0, { timeout: 15_000 })
    const classOf = (text: RegExp): Promise<string | null> =>
      plain.locator('.view-line span span').filter({ hasText: text }).first().getAttribute('class')
    const keyword = await classOf(/^export$/)
    const identifier = await classOf(/^greet$/)
    expect(keyword).toMatch(/mtk\d+/)
    expect(identifier).toMatch(/mtk\d+/)
    expect(keyword).not.toBe(identifier)
  } finally {
    await app.close()
  }
})

test('the TypeScript server folds an import block, counts references above a function and finds a symbol in the workspace', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(
    {
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
      'main.ts': [
        "import { one } from './lib'",
        "import { two } from './lib'",
        "import { three } from './lib'",
        'export function greetEveryone(name: string): string {',
        '  return `hi ${name} ${one}${two}${three}`',
        '}',
        "export const greeting = greetEveryone('a')",
        '',
      ].join('\n'),
      'lib.ts': 'export const one = 1\nexport const two = 2\nexport const three = 3\n',
    },
    fromMarketplace('lsp-typescript'),
    { extensionSettings: { 'lsp-typescript': { referencesCodeLens: true } } },
  )
  try {
    await approve(win, 'TypeScript and JavaScript', 'server/typescript-language-server/lib/cli.mjs')
    await openWorkspace(win)
    const editor = await openFile(win, 'main.ts')
    const lines = editor.locator('.view-lines')

    const lens = editor.locator('.codelens-decoration')
    await expect(lens.filter({ hasText: '1 reference' }).first()).toBeVisible({ timeout: 60_000 })
    await expect(lens.locator('a')).toHaveCount(0)

    await expect(lines).toContainText('two')
    await expect(async () => {
      await editor
        .locator('.view-line')
        .filter({ hasText: 'one' })
        .first()
        .click({ position: { x: 30, y: 8 } })
      await win.keyboard.press('Control+Shift+BracketLeft')
      await expect(lines).not.toContainText('three }', { timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await expect(lines).toContainText('greetEveryone')
    await win.keyboard.press('Control+Shift+BracketRight')
    await expect(lines).toContainText('three }', { timeout: 10_000 })

    await win.keyboard.press('Control+Shift+P')
    const palette = win.getByRole('dialog').filter({ has: win.getByRole('combobox') })
    await palette.getByRole('combobox').fill('%greetEvery')
    const symbol = palette.getByRole('option', { name: /greetEveryone/ }).first()
    await expect(symbol).toContainText('main.ts:4', { timeout: 30_000 })
    await symbol.click()
    await expect(palette).toBeHidden()
  } finally {
    await app.close()
  }
})

test('the Pyright extension’s bundled server checks a .py file', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(
    {
      'main.py':
        'def greet(name: str) -> str:\n    return "hi " + name\n\n\ncount: int = greet("a")\n',
    },
    fromMarketplace('lsp-pyright'),
  )
  try {
    await approve(win, 'Python (Pyright)', 'server/pyright/langserver.index.js')
    await openWorkspace(win)
    const editor = await openFile(win, 'main.py')
    await expect(editor.locator('.squiggly-error')).toHaveCount(1, { timeout: 60_000 })
    const diagnostic = await hoverOn(win, editor.locator('.squiggly-error').first())
    await expect(diagnostic).toContainText('"str" is not assignable to "int"')
    await expect(diagnostic).toContainText('Pyright')
    await win.keyboard.press('Escape')

    const signature = await hoverOn(
      win,
      editor
        .locator('.view-line')
        .first()
        .locator('span span')
        .filter({ hasText: /^greet$/ }),
    )
    await expect(signature).toContainText('def greet(name: str) -> str')

    await win.keyboard.press('Escape')

    await win.keyboard.press('Control+Shift+P')
    const palette = win.getByRole('dialog').filter({ has: win.getByRole('combobox') })
    await palette.getByRole('combobox').fill('%greet')
    const symbol = palette.getByRole('option', { name: /greet/ }).first()
    await expect(symbol).toContainText('main.py:1', { timeout: 30_000 })
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    const row = await serverRow(win, 'Pyright')
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
  } finally {
    await app.close()
  }
})

test('a server that claims JSON replaces Monaco’s JSON features, except in the settings file', async () => {
  const { app, win, settingsFile } = await launch(
    { 'data.json': '{ "a": ERROR }\n' },
    (extensionsDir) => installFakeLanguageExtension(extensionsDir, 'fake-json'),
    { locale: 5, noteERROR: true },
  )
  try {
    await approve(win, 'Fake JSON', 'server/fake-server.cjs')
    await openWorkspace(win)
    const data = await openFile(win, 'data.json')
    await expect(data.locator('.squiggly-error')).toHaveCount(1, { timeout: 20_000 })
    const fromServer = await hoverOn(win, data.locator('.squiggly-error').first())
    await expect(fromServer).toContainText('fake error on line 1')
    await win.keyboard.press('Escape')

    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).locale).toBe(5)
    await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
    await win.locator('.pane-tab').filter({ hasNotText: 'data.json' }).first().click()
    await win.locator('.xterm:visible').first().click()
    await win.keyboard.type(`ostia open ${settingsFile}`)
    await win.keyboard.press('Enter')
    const settings = win.locator('.monaco-editor:visible').first()
    await expect(settings.locator('.view-lines')).toContainText('noteERROR', { timeout: 15_000 })
    await expect(settings.locator('.squiggly-warning').first()).toBeVisible({ timeout: 20_000 })
    await expect(settings.locator('.squiggly-error')).toHaveCount(0)
    const fromSchema = await hoverOn(win, settings.locator('.squiggly-warning').first())
    await expect(fromSchema).toContainText(/Incorrect type|not allowed/)
  } finally {
    await app.close()
  }
})

test('the YAML extension’s bundled server checks a .yaml file', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(
    { 'config.yaml': 'name: demo\nitems:\n  - one\nbad: [unclosed\n' },
    fromMarketplace('lsp-yaml'),
  )
  try {
    await approve(win, 'YAML', 'server/node_modules/yaml-language-server/out/server/src/server.js')
    await openWorkspace(win)
    const editor = await openFile(win, 'config.yaml')
    await expect(editor.locator('.squiggly-error').first()).toBeVisible({ timeout: 60_000 })
    const row = await serverRow(win, 'yaml-language-server')
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
    await row.getByRole('button', { name: 'Show the log of yaml-language-server' }).click()
    await expect(win.getByRole('dialog').filter({ hasText: 'Log of' })).toContainText(
      'Initialized yaml-language-server',
    )
  } finally {
    await app.close()
  }
})

test('the Bash extension’s bundled server describes a function in a .sh file', async () => {
  test.setTimeout(120_000)
  const { app, win } = await launch(
    { 'run.sh': '#!/bin/bash\ngreet() {\n  echo "hi $1"\n}\ngreet world\n' },
    fromMarketplace('lsp-bash'),
  )
  try {
    await approve(
      win,
      'Shell scripts (Bash)',
      'server/node_modules/bash-language-server/out/cli.js',
    )
    await openWorkspace(win)
    const editor = await openFile(win, 'run.sh')
    const call = editor.locator('.view-line').nth(4)
    await expect(async () => {
      const hover = await hoverOn(win, call, { x: 6, y: 8 })
      await expect(hover).toContainText('Function: greet', { timeout: 3_000 })
    }).toPass({ timeout: 60_000 })
    const row = await serverRow(win, 'bash-language-server')
    await expect(row.getByTestId('language-server-status')).toHaveText('Running (1 folder)')
  } finally {
    await app.close()
  }
})
