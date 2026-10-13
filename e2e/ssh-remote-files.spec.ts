import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

const FAKE_SSH_BIN = resolve(__dirname, '../test/fixtures/ssh/bin')
const SSH_CAPTURES = resolve(__dirname, '../test/fixtures/ssh')

async function approveNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { ostiaE2eAsked?: unknown[] }
    g.ostiaE2eAsked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.ostiaE2eAsked?.push(args.length > 1 ? args[1] : args[0])
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}

async function runPaletteCommand(win: Page, title: string): Promise<void> {
  await win.keyboard.press(chords.palette)
  await win.locator('[data-slot="command-input"]').fill(title)
  await waitForPaletteSelection(win, title)
  await win.keyboard.press('Enter')
}

interface Session {
  app: ElectronApplication
  win: Page
  remoteHome: string
  project: string
  sshLog: string
}

async function sessionInProject(): Promise<Session> {
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const home = launch.env.HOME
  mkdirSync(join(home, '.ssh'), { recursive: true })
  writeFileSync(join(home, '.ssh', 'config'), 'Host db\n  HostName 10.0.0.5\n')
  const remoteHome = mkdtempSync(join(dataHome, 'remote-home-'))
  const remoteTmp = mkdtempSync(join(dataHome, 'remote-tmp-'))
  const project = join(remoteHome, 'project')
  const sshLog = join(dataHome, 'ssh-calls.log')
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
      FAKE_SSH_LOG: sshLog,
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
  await win.keyboard.type('ostia ssh connect db')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 40_000 })
  const sshPane = win.locator('[data-pane-id]').filter({ hasText: 'fake ssh session' })
  await expect(sshPane.locator('.xterm-rows')).toContainText('remote$', { timeout: 40_000 })
  await sshPane.locator('.xterm').click()
  await win.keyboard.type('cd ~/project && echo in-$((40+2))')
  await win.keyboard.press('Enter')
  await expect(sshPane.locator('.xterm-rows')).toContainText(/in-42\s*remote\$/, {
    timeout: 15_000,
  })
  await win.waitForTimeout(500)
  return { app, win, remoteHome, project, sshLog }
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

test('SSH-C66 SSH-C68 a remote file saves through the helper and follows changes on the host', async () => {
  test.setTimeout(180_000)
  const session = await sessionInProject()
  const { app, win, project } = session
  const file = join(project, 'app.conf')
  chmodSync(file, 0o640)
  try {
    await openRemoteFolder(session)
    const section = win.getByTestId('remote-folder')
    await section.getByRole('button', { name: 'app.conf', exact: true }).click()
    const bar = win.getByTestId('remote-file-bar')
    const editorPane = win.locator('.surface-host').filter({ has: bar })
    const lines = editorPane.locator('.view-lines')
    await expect(lines).toContainText('port=8080', { timeout: 20_000 })

    await lines.click()
    await win.keyboard.press(chords.documentEnd)
    await win.keyboard.type('mode=fast')
    await win.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 })
      .toBe('port=8080\nmode=fast')
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(readdirSync(project).sort()).toEqual(['app.conf', 'conf'])

    writeFileSync(file, 'port=9090\n')
    await expect(lines).toContainText('port=9090', { timeout: 20_000 })
    await expect(lines).not.toContainText('mode=fast')

    await lines.click()
    await win.keyboard.press(chords.documentEnd)
    await win.keyboard.type('mine=1')
    writeFileSync(file, 'port=7070\n')
    await expect(editorPane).toContainText('Changed on disk. Your unsaved edits are kept.', {
      timeout: 20_000,
    })
    await expect(lines).toContainText('mine=1')
    expect(readFileSync(file, 'utf8')).toBe('port=7070\n')
    await editorPane.getByRole('button', { name: 'Keep mine' }).click()
    await lines.click()
    await win.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 })
      .toBe('port=9090\nmine=1')
    expect(readdirSync(project).sort()).toEqual(['app.conf', 'conf'])
  } finally {
    await app.close()
  }
})
