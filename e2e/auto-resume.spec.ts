import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  PROMPT,
  addTab,
  newTerminalWorkspace,
  openWorkspace,
  pressQuit,
  shownTerminal,
  waitForExit,
} from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.describe.configure({ timeout: 90_000 })

const RESUME_ID = 'e2e-resume-4242'
const AUTO_RESUME_SETTINGS = { ...DOM_RENDERER_SETTINGS, agents: { autoResume: true } }

function resumedLog(dataHome: string): string {
  return join(dataHome, 'resumed.log')
}

function fakeResumableClaude(
  dataHome: string,
  turn?: 'working' | 'done',
  session = RESUME_ID,
): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  const cli = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
  const report = turn ? [`     sleep 1; ${cli} state ${turn} >/dev/null 2>&1`] : []
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *--resume*) echo "fake-agent-resumed $* GL=\${GL_ISSUE-none} TOK=\${API_TOKEN-none} END" | tee -a '${resumedLog(dataHome)}' ;;`,
      `  *) ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude ${session} >/dev/null 2>&1`,
      ...report,
      '     echo fake-agent-ready ;;',
      'esac',
      'exec cat',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  return bin
}

async function launchAgentApp(
  dataHome: string,
  turn?: 'working' | 'done',
  session?: string,
): Promise<{ app: ElectronApplication; win: Page; proc: ChildProcess }> {
  const bin = fakeResumableClaude(dataHome, turn, session)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, PATH: `${bin}:${launch.env.PATH}` },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, proc: app.process() }
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

async function quitAndWait(app: ElectronApplication, win: Page): Promise<void> {
  await Promise.all([waitForExit(app), win.evaluate(() => window.ostia.window.quit())])
}

async function closeAsked(app: ElectronApplication, win: Page): Promise<void> {
  const closed = app.close().catch(() => {})
  const quit = win.getByRole('dialog').getByRole('button', { name: 'Quit' })
  await Promise.race([closed, quit.click({ timeout: 15_000 }).catch(() => {})])
  await closed
}

async function expectAutoResumed(dataHome: string): Promise<void> {
  const { app, win } = await launchAgentApp(dataHome)
  try {
    await expect(win.locator('.pane-slot:not([data-hidden]) .xterm-rows')).toContainText(
      new RegExp(`fake-agent-resumed .*--resume ${RESUME_ID}`),
      { timeout: 20_000 },
    )
  } finally {
    await closeAsked(app, win)
  }
}

test(
  'an agent running when the human quits Ostia resumes after the restart',
  { tag: '@core' },
  async () => {
    const dataHome = freshDataHome()
    seedSettings(dataHome, AUTO_RESUME_SETTINGS)
    const { app, win } = await launchAgentApp(dataHome)
    await startResumableAgent(dataHome, win)
    await quitAndWait(app, win)
    expect(agentRunningSaved(dataHome)).toBe(true)
    await expectAutoResumed(dataHome)
  },
)

const SESSION_PER_PANE = 'e2e-pane-$OSTIA_PANE_ID'
const SHOWN_ROWS = '.workzone-workspace:not([data-hidden]) .pane-slot:not([data-hidden]) .xterm-rows'

function resumedSessions(dataHome: string): string[] {
  const log = existsSync(resumedLog(dataHome)) ? readFileSync(resumedLog(dataHome), 'utf8') : ''
  return [...log.matchAll(/--resume e2e-pane-(\S+)/g)].map((m) => m[1]).sort()
}

function shownState(dataHome: string): { workspace: unknown; tabs: unknown[] } {
  const saved = JSON.parse(readFileSync(join(dataHome, 'ostia', 'workspaces.json'), 'utf8'))
  const tabs: unknown[] = []
  const walk = (node: Record<string, unknown> | undefined): void => {
    if (!node) return
    if (node.type === 'tabs') tabs.push(node.activeId)
    for (const child of (node.children as Record<string, unknown>[] | undefined) ?? []) walk(child)
  }
  for (const w of saved.workspaces) walk(w.root)
  return { workspace: saved.activeWorkspaceId, tabs }
}

function focusedPane(win: Page): Promise<string | null> {
  return win.evaluate(
    () =>
      document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
  )
}

async function startAgentInShownTerminal(dataHome: string, win: Page, agents: number) {
  await expect(win.locator(SHOWN_ROWS)).toContainText(PROMPT, { timeout: 15_000 })
  await shownTerminal(win).click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(win.locator(SHOWN_ROWS)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await expect
    .poll(() => savedPanes(dataHome).filter((p) => p.agentRunning === true).length, {
      timeout: 15_000,
    })
    .toBe(agents)
}

test('agents in a background tab and in another workspace resume without being shown', async () => {
  test.setTimeout(180_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome, undefined, SESSION_PER_PANE)
  await openWorkspace(win)
  await startAgentInShownTerminal(dataHome, win, 1)
  await addTab(win)
  await expect(win.getByRole('tablist').getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
  await startAgentInShownTerminal(dataHome, win, 2)
  await newTerminalWorkspace(win)
  await startAgentInShownTerminal(dataHome, win, 3)
  await win.locator('.rail-row').first().click()
  await expect(win.locator(SHOWN_ROWS)).toHaveCount(1)
  await shownTerminal(win).click()
  await expect.poll(() => focusedPane(win)).not.toBeNull()
  const focused = await focusedPane(win)
  await quitAndWait(app, win)
  const before = shownState(dataHome)
  const panes = savedPanes(dataHome)
    .map((p) => String(p.id))
    .sort()
  expect(panes).toHaveLength(3)

  const relaunched = await launchAgentApp(dataHome, undefined, SESSION_PER_PANE)
  try {
    await expect.poll(() => focusedPane(relaunched.win), { timeout: 15_000 }).toBe(focused)
    await expect.poll(() => resumedSessions(dataHome), { timeout: 60_000 }).toEqual(panes)
    await expect(relaunched.win.locator(SHOWN_ROWS)).toContainText(
      `--resume e2e-pane-${focused}`,
    )
    expect(await focusedPane(relaunched.win)).toBe(focused)
    expect(shownState(dataHome)).toEqual(before)
  } finally {
    await closeAsked(relaunched.app, relaunched.win)
  }
})

test('an agent a coordinator started with process run resumes with its flags and variables, not its prompt or secrets', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome)
  await openWorkspace(win)
  await win.locator('.xterm').first().click()
  await win.keyboard.type(
    `ostia process run "GL_ISSUE='665#2' API_TOKEN=abc claude --agent X --model Y -n \\"Slack push\\" --dangerously-skip-permissions hello" --name line`,
  )
  await win.keyboard.press('Enter')
  await expect(win.getByRole('tablist').getByRole('tab')).toHaveCount(2, { timeout: 15_000 })
  await expect.poll(() => agentRunningSaved(dataHome), { timeout: 20_000 }).toBe(true)
  await quitAndWait(app, win)
  const relaunched = await launchAgentApp(dataHome)
  try {
    await expect
      .poll(
        () => (existsSync(resumedLog(dataHome)) ? readFileSync(resumedLog(dataHome), 'utf8') : ''),
        {
          timeout: 30_000,
        },
      )
      .toMatch(
        new RegExp(
          `^fake-agent-resumed --plugin-dir [^ ]+ --resume ${RESUME_ID} --agent X --model Y --name Slack push --dangerously-skip-permissions GL=665#2 TOK=none END$`,
          'm',
        ),
      )
  } finally {
    await closeAsked(relaunched.app, relaunched.win)
  }
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

const CONFIRM_QUIT_SETTINGS = {
  ...AUTO_RESUME_SETTINGS,
  workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
}

test('quitting with an agent mid-turn still asks, and names the agent it would stop', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, CONFIRM_QUIT_SETTINGS)
  const { app, win, proc } = await launchAgentApp(dataHome, 'working')
  try {
    await startResumableAgent(dataHome, win)
    expect(await pressQuit(app, win)).toBe('asked')
    const dialog = win.getByRole('dialog')
    await expect(dialog).toContainText('1 agent will be stopped')
    await Promise.all([waitForExit(app), dialog.getByRole('button', { name: 'Quit' }).click()])
  } finally {
    proc.kill('SIGKILL')
  }
})
