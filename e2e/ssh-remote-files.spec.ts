import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'

const FAKE_SSH_BIN = resolve(__dirname, '../test/fixtures/ssh/bin')
const SSH_CAPTURES = resolve(__dirname, '../test/fixtures/ssh')

interface AskedDialog {
  message?: string
  detail?: string
  buttons?: string[]
}

async function approveNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { pineE2eAsked?: unknown[] }
    g.pineE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.pineE2eAsked?.push(args.length > 1 ? args[1] : args[0])
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}

function askedDialogs(app: ElectronApplication): Promise<AskedDialog[]> {
  return app.evaluate(
    () => ((globalThis as { pineE2eAsked?: unknown[] }).pineE2eAsked ?? []) as AskedDialog[],
  )
}

async function runPaletteCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press('Control+Shift+P')
  await win.locator('[data-slot="command-input"]').fill(title)
  await waitForPaletteSelection(win, title)
  await win.keyboard.press('Enter')
}

interface Session {
  app: ElectronApplication
  win: Page
  remoteHome: string
  project: string
}

async function sessionInProject(): Promise<Session> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const launch = isolatedLaunch(dataHome)
  const home = launch.env.HOME
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host db\n  HostName 10.0.0.5\n')
  const remoteHome = mkdtempSync(join(dataHome, 'remote-home-'))
  const remoteTmp = mkdtempSync(join(dataHome, 'remote-tmp-'))
  const project = join(remoteHome, 'project')
  mkdirSync(join(project, 'conf'), { recursive: true })
  writeFileSync(join(project, 'app.conf'), 'port=8080\n')
  writeFileSync(join(project, 'conf', 'db.yaml'), 'name: main\n')
  writeFileSync(join(remoteHome, '.bash_profile'), "HOSTNAME=fake-remote\nPS1='remote$ '\n")
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${FAKE_SSH_BIN}:${process.env.PATH}`,
      FAKE_SSH_DIR: SSH_CAPTURES,
      FAKE_SSH_REMOTE_SHELL: 'bash',
      FAKE_SSH_REMOTE_HOME: remoteHome,
      FAKE_SSH_REMOTE_TMP: remoteTmp,
    },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await openWorkspace(win)
  await approveNativeDialogs(app)
  await win.locator('.xterm').first().click()
  await win.keyboard.type('pine ssh connect db')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 40_000 })
  const sshPane = win.locator('[data-pane-id]').filter({ hasText: 'fake ssh session' })
  await expect(sshPane.locator('.xterm-rows')).toContainText('remote$', { timeout: 40_000 })
  await sshPane.locator('.xterm').click()
  await win.keyboard.type('cd ~/project && echo in-$((40+2))')
  await win.keyboard.press('Enter')
  await expect(sshPane.locator('.xterm-rows')).toContainText('in-42', { timeout: 15_000 })
  return { app, win, remoteHome, project }
}

async function openRemoteFolder({ win, project }: Session): Promise<void> {
  await runPaletteCommand(win, 'SSH: Open Remote Folder')
  const dialog = win.getByTestId('remote-folder-dialog')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog).toContainText('SSH will show this folder in Files')
  await expect(dialog).toContainText('db')
  await expect(dialog).toContainText(project)
  await dialog.getByRole('button', { name: 'Open' }).click()
  await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
}

test('SSH-C65 the human opens the folder of an ssh session in Files and reads a remote file', async () => {
  test.setTimeout(180_000)
  const session = await sessionInProject()
  const { app, win, remoteHome, project } = session
  try {
    await openRemoteFolder(session)

    const section = win.getByTestId('remote-folder')
    await expect(section).toBeVisible({ timeout: 15_000 })
    await expect(section).toContainText('Remote')
    await expect(section).toContainText('db')
    await expect(section).toContainText(project)
    const row = (name: string) => section.getByRole('button', { name, exact: true })
    await expect(row('app.conf')).toBeVisible({ timeout: 15_000 })
    await row('conf').click()
    await expect(row('db.yaml')).toBeVisible({ timeout: 15_000 })

    await row('app.conf').click()
    const bar = win.getByTestId('remote-file-bar')
    await expect(bar).toContainText('Remote file on db', { timeout: 15_000 })
    await expect(bar).toContainText('Read-only')
    const editorPane = win.locator('[data-pane-id]').filter({ has: bar })
    await expect(editorPane.locator('.view-lines')).toContainText('port=8080', { timeout: 15_000 })

    const versions = readdirSync(join(remoteHome, '.pine', 'helper'))
    expect(versions).toHaveLength(1)
    const installed = readFileSync(join(remoteHome, '.pine', 'helper', versions[0], 'helper.sh'))
    const shipped = readFileSync(resolve(__dirname, '../src/extensions/ssh/assets/helper.sh'))
    expect(installed.equals(shipped)).toBe(true)

    const asked = await askedDialogs(app)
    expect(asked).toHaveLength(2)
    expect(asked[1].message).toContain('db')
    expect(asked[1].detail).toContain(`~/.pine/helper/${versions[0]}/helper.sh`)
    expect(asked[1].buttons).toEqual(['Install', 'Don’t install'])

    await section.getByRole('button', { name: 'Close remote folder' }).click()
    await expect(win.getByTestId('remote-folder')).toHaveCount(0)
    await expect(bar).toContainText('This remote folder is closed')
    expect(existsSync(join(project, 'app.conf'))).toBe(true)
  } finally {
    await app.close()
  }
})
