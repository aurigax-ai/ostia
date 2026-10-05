import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'

function seedAgentTabs(dataHome: string): void {
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  const tab = (id: string, resumeId: string) => ({
    type: 'pane',
    id,
    title: 'claude',
    kind: 'terminal',
    cwd: dataHome,
    resume: { agent: 'claude', id: resumeId },
    agentRunning: true,
  })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      groups: [],
      workspaces: [
        {
          id: 's1',
          name: 'agents',
          kind: 'terminal',
          workDir: dataHome,
          root: {
            type: 'tabs',
            id: 'tabs-1',
            activeId: 'pane-1',
            children: [tab('pane-1', 'front-1111'), tab('pane-2', 'back-2222')],
          },
          activePaneId: 'pane-1',
        },
        {
          id: 's2',
          name: 'elsewhere',
          kind: 'terminal',
          workDir: dataHome,
          root: tab('pane-3', 'other-3333'),
          activePaneId: 'pane-3',
        },
      ],
    }),
  )
}

function launchWithFakeClaude(dataHome: string) {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(claude, '#!/bin/sh\necho "fake claude $*"\n')
  chmodSync(claude, 0o755)
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  const launch = isolatedLaunch(dataHome)
  return electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, PATH: `${bin}:${launch.env.PATH}` },
  })
}

test('with auto-resume on, every agent resumes at startup: shown tab, background tab and unopened workspace', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, agents: { autoResume: true } })
  seedAgentTabs(dataHome)
  const app = await launchWithFakeClaude(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const shown = win.locator(
      '.workzone-workspace:not([aria-hidden="true"]) .pane-slot:not([data-hidden]) .xterm-rows',
    )
    await expect(shown).toContainText('claude --resume front-1111', { timeout: 20_000 })
    await expect(shown).toContainText('fake claude', { timeout: 10_000 })
    for (const id of ['back-2222', 'other-3333']) {
      await expect(
        win.locator('.xterm-rows').filter({ hasText: new RegExp(`fake claude .*--resume ${id}`) }),
      ).toHaveCount(1, { timeout: 20_000 })
    }
    await expect(win.getByRole('tab', { selected: true })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('with auto-resume off, a restored agent tab only offers the Resume button', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  seedAgentTabs(dataHome)
  const app = await launchWithFakeClaude(dataHome)
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.getByRole('button', { name: /Resume claude/ })).toBeVisible({
      timeout: 20_000,
    })
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(/[❯$%#]/, {
      timeout: 15_000,
    })
    await expect(win.locator('.xterm-rows').filter({ hasText: 'claude --resume' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test.describe.configure({ timeout: 90_000 })

const RESUME_ID = 'e2e-resume-4242'
const AUTO_RESUME_SETTINGS = { ...DOM_RENDERER_SETTINGS, agents: { autoResume: true } }

function fakeResumableClaude(dataHome: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *--resume*) echo "fake-agent-resumed $*" ;;',
      `  *) ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude ${RESUME_ID} >/dev/null 2>&1`,
      '     echo fake-agent-ready ;;',
      'esac',
      'exec cat',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  return bin
}

async function launchAgentApp(dataHome: string): Promise<{ app: ElectronApplication; win: Page }> {
  const bin = fakeResumableClaude(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

function savedPanes(dataHome: string): Record<string, unknown>[] {
  const file = join(dataHome, 'ostia', 'workspaces.json')
  if (!existsSync(file)) return []
  const out: Record<string, unknown>[] = []
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node) return
    if (node.type === 'pane') out.push(node)
    for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) walk(child)
  }
  for (const w of JSON.parse(readFileSync(file, 'utf8')).workspaces) walk(w.root)
  return out
}

function agentRunningSaved(dataHome: string): boolean {
  return savedPanes(dataHome).some((p) => p.agentRunning === true)
}

async function startResumableAgent(dataHome: string, win: Page): Promise<string> {
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
    timeout: 15_000,
  })
  await expect.poll(() => agentRunningSaved(dataHome), { timeout: 15_000 }).toBe(true)
  return String(savedPanes(dataHome)[0].id)
}

async function waitForExit(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

async function quitAndWait(app: ElectronApplication, win: Page): Promise<void> {
  await Promise.all([waitForExit(app), win.evaluate(() => window.ostia.window.quit())])
}

async function expectAutoResumed(dataHome: string): Promise<void> {
  const { app, win } = await launchAgentApp(dataHome)
  try {
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      new RegExp(`fake-agent-resumed .*--resume ${RESUME_ID}`),
      { timeout: 20_000 },
    )
  } finally {
    const closed = app.close().catch(() => {})
    const quit = win.getByRole('dialog').getByRole('button', { name: 'Quit' })
    await Promise.race([closed, quit.click({ timeout: 15_000 }).catch(() => {})])
    await closed
  }
}

test('an agent running when the human quits Ostia resumes after the restart', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome)
  await startResumableAgent(dataHome, win)
  await quitAndWait(app, win)
  expect(agentRunningSaved(dataHome)).toBe(true)
  await expectAutoResumed(dataHome)
})

test('an agent running when the window closes with close-to-tray off resumes after the restart', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...AUTO_RESUME_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, closeToTray: false },
  })
  const { app, win } = await launchAgentApp(dataHome)
  await startResumableAgent(dataHome, win)
  await Promise.all([waitForExit(app), win.evaluate(() => window.ostia.window.close())])
  expect(agentRunningSaved(dataHome)).toBe(true)
  await expectAutoResumed(dataHome)
})

test('an agent running when the main process gets SIGTERM resumes after the restart', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...AUTO_RESUME_SETTINGS,
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
  })
  const { app, win } = await launchAgentApp(dataHome)
  await startResumableAgent(dataHome, win)
  const scrollback = join(dataHome, 'ostia', 'scrollback.json')
  rmSync(scrollback, { force: true })
  app.process().kill('SIGTERM')
  await waitForExit(app)
  expect(existsSync(scrollback), 'scrollback was not saved on SIGTERM').toBe(true)
  expect(agentRunningSaved(dataHome)).toBe(true)
  await expectAutoResumed(dataHome)
})

test('an agent whose shell Ostia reaped resumes after the restart, whatever the renderer saves', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome)
  const paneId = await startResumableAgent(dataHome, win)
  const snapshot = JSON.parse(readFileSync(join(dataHome, 'ostia', 'workspaces.json'), 'utf8'))
  await win.evaluate((id) => window.ostia.pty.detach(id), paneId)
  await win.waitForTimeout(4_000)
  const withoutAgent = JSON.parse(
    JSON.stringify(snapshot, (key, value) => (key === 'agentRunning' ? undefined : value)),
  )
  await win.evaluate((s) => window.ostia.workspace.save(s), withoutAgent)
  await win.waitForTimeout(500)
  expect(agentRunningSaved(dataHome)).toBe(true)
  app.process().kill('SIGKILL')
  await waitForExit(app)
  await expectAutoResumed(dataHome)
})

test('an agent that exited before the quit does not resume after the restart', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome)
  await startResumableAgent(dataHome, win)
  await win.keyboard.press('Control+d')
  await expect.poll(() => agentRunningSaved(dataHome), { timeout: 10_000 }).toBe(false)
  await quitAndWait(app, win)
  expect(agentRunningSaved(dataHome)).toBe(false)

  const second = await launchAgentApp(dataHome)
  try {
    await expect(second.win.getByRole('button', { name: /Resume claude/ })).toBeVisible({
      timeout: 20_000,
    })
    const shown = second.win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(shown).toContainText(/[❯$%#]/, { timeout: 15_000 })
    await second.win.waitForTimeout(1_500)
    await expect(shown).not.toContainText('fake-agent-resumed')
  } finally {
    await second.app.close().catch(() => {})
  }
})
