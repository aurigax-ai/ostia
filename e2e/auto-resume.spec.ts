import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from './chords'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from './dataHome'
import {
  PROMPT,
  addTab,
  expectHeld,
  newTerminalWorkspace,
  openWorkspace,
  restartApp,
  shownTerminal,
  typeLine,
} from './helpers'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
  waitForExit,
} from './test'

test.describe.configure({ timeout: 90_000 })

const RESUME_ID = 'e2e-resume-4242'
const CLEARED_ID = 'e2e-cleared-5151'
const AUTO_RESUME_SETTINGS = { ...DOM_RENDERER_SETTINGS, agents: { autoResume: true } }

function resumedLog(dataHome: string): string {
  return join(dataHome, 'resumed.log')
}

function fakeResumableClaude(
  dataHome: string,
  session = RESUME_ID,
  failResume = false,
  clearedTo?: string,
): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  const report = `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude ${session} >/dev/null 2>&1`
  writeFileSync(
    claude,
    [
      '#!/bin/sh',
      'case "$*" in',
      failResume
        ? `  *--resume*) echo "No conversation found with session ID: $2" | tee -a '${resumedLog(dataHome)}'; exit 1 ;;`
        : `  *--resume*) echo "fake-agent-resumed $* GL=\${GL_ISSUE-none} TOK=\${API_TOKEN-none} END" | tee -a '${resumedLog(dataHome)}' ;;`,
      `  *) ${report}`,
      '     echo fake-agent-ready ;;',
      'esac',
      clearedTo
        ? `while IFS= read -r line; do [ "$line" = /clear ] && ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude ${clearedTo} >/dev/null 2>&1; done`
        : 'exec cat',
      '',
    ].join('\n'),
  )
  chmodSync(claude, 0o755)
  return bin
}

async function launchAgentApp(
  dataHome: string,
  session?: string,
  failResume = false,
  clearedTo?: string,
): Promise<{ app: ElectronApplication; win: Page }> {
  const bin = fakeResumableClaude(dataHome, session, failResume, clearedTo)
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

test('a resume that fails shows one note and is never typed again', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const typedLine = `'claude' --resume ${RESUME_ID}`
  const resumes = () =>
    existsSync(resumedLog(dataHome))
      ? readFileSync(resumedLog(dataHome), 'utf8').split('No conversation found').length - 1
      : 0
  const first = await launchAgentApp(dataHome, RESUME_ID, true)
  await startResumableAgent(dataHome, first.win)
  await quitAndWait(first.app, first.win)

  const { app, win } = await launchAgentApp(dataHome, RESUME_ID, true)
  try {
    const rows = win.locator(SHOWN_ROWS)
    await expect(win.getByRole('region', { name: 'Agent resume failed' })).toContainText(
      'it exited with code 1',
      { timeout: 20_000 },
    )
    await expect(rows).toContainText('workspace restored', { timeout: 20_000 })
    await expect(rows).toContainText(PROMPT, { timeout: 15_000 })
    await expectHeld(async () => resumes(), 1)
    const text = await rows.innerText()
    expect(text.split('workspace restored').length - 1).toBe(1)
    expect(text.split(typedLine).length - 1).toBe(1)
    expect(agentRunningSaved(dataHome)).toBe(false)
  } finally {
    await quitAndWait(app, win)
  }
})

const SESSION_PER_PANE = 'e2e-pane-$OSTIA_PANE_ID'
const SHOWN_ROWS =
  '.workzone-workspace:not([data-hidden]) .pane-slot:not([data-hidden]) .xterm-rows'

function resumedSessions(dataHome: string): string[] {
  const log = existsSync(resumedLog(dataHome)) ? readFileSync(resumedLog(dataHome), 'utf8') : ''
  return [...new Set([...log.matchAll(/--resume e2e-pane-(\S+)/g)].map((m) => m[1]))]
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

function slowShellStart(dataHome: string, seconds: number): void {
  const home = testHome(dataHome)
  for (const rc of ['.zshrc', '.bashrc']) {
    const file = join(home, rc)
    writeFileSync(file, `sleep ${seconds}\n${readFileSync(file, 'utf8')}`)
  }
}

function focusedPane(win: Page): Promise<string | null> {
  return win.evaluate(
    () => document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
  )
}

async function startAgentInShownTerminal(
  dataHome: string,
  win: Page,
  agents: number,
  line = 'claude',
) {
  await expect(win.locator(SHOWN_ROWS)).toContainText(PROMPT, { timeout: 15_000 })
  await shownTerminal(win).click()
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
  await expect(win.locator(SHOWN_ROWS)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await expect
    .poll(() => savedPanes(dataHome).filter((p) => p.agentRunning === true).length, {
      timeout: 15_000,
    })
    .toBe(agents)
}

test('agents in a background tab and in another workspace resume without being shown', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome, SESSION_PER_PANE)
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
  expect(savedPanes(dataHome).filter((p) => p.agentRunning === true)).toHaveLength(3)

  const relaunched = await launchAgentApp(dataHome, SESSION_PER_PANE)
  try {
    await expect.poll(() => focusedPane(relaunched.win)).toBe(focused)
    await expect.poll(() => resumedSessions(dataHome), { timeout: 30_000 }).toHaveLength(3)
    await expect(relaunched.win.locator(SHOWN_ROWS)).toContainText('fake-agent-resumed')
    expect(await focusedPane(relaunched.win)).toBe(focused)
    expect(shownState(dataHome)).toEqual(before)
  } finally {
    await closeAsked(relaunched.app, relaunched.win)
  }
})

test('an agent resumed in a visible split leaves keyboard focus in the pane the human was in', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const { app, win } = await launchAgentApp(dataHome)
  await openWorkspace(win)
  await startAgentInShownTerminal(dataHome, win, 1)
  const agentPane = String(savedPanes(dataHome).find((p) => p.agentRunning === true)?.id)
  await win.keyboard.press(chords.splitRight)
  const plain = win.locator(`.surface-host:not([data-pane-id="${agentPane}"]) .xterm`)
  await expect(win.locator('.xterm:visible')).toHaveCount(2, { timeout: 15_000 })
  await expect(plain.locator('.xterm-rows')).toContainText(PROMPT, { timeout: 15_000 })
  await plain.click()
  await expect.poll(() => focusedPane(win)).not.toBeNull()
  const focused = await focusedPane(win)
  expect(focused).not.toBe(agentPane)
  await quitAndWait(app, win)

  slowShellStart(dataHome, 6)
  const relaunched = await launchAgentApp(dataHome)
  try {
    await expect.poll(() => focusedPane(relaunched.win)).toBe(focused)
    expect(existsSync(resumedLog(dataHome))).toBe(false)
    await expect.poll(() => existsSync(resumedLog(dataHome)), { timeout: 30_000 }).toBe(true)
    await expect(relaunched.win.locator('.xterm-rows:visible')).toHaveCount(2)
    expect(await focusedPane(relaunched.win)).toBe(focused)
  } finally {
    await closeAsked(relaunched.app, relaunched.win)
  }
})

test('agents the human typed after a cd and a coordinator started with process run resume with the variables, agent and permission bypass of their typed lines, not their prompt or secrets', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, AUTO_RESUME_SETTINGS)
  const resumedRuns = () =>
    existsSync(resumedLog(dataHome))
      ? readFileSync(resumedLog(dataHome), 'utf8').split('\n').filter(Boolean)
      : []
  const flags = `GL_ISSUE='665#2' API_TOKEN=abc claude --agent X --model Y -n "Slack push" --dangerously-skip-permissions`
  const first = await launchAgentApp(dataHome, SESSION_PER_PANE)
  await openWorkspace(first.win)
  await first.win.locator('.xterm').first().click()
  await typeLine(first.win, `ostia process run "${flags.replaceAll('"', '\\"')} hello" --name line`)
  await expect(first.win.getByRole('tablist').getByRole('tab')).toHaveCount(2, {
    timeout: 15_000,
  })
  await expect.poll(() => savedPanes(dataHome).filter((p) => p.agentRunning).length).toBe(1)
  await first.win.getByRole('tablist').getByRole('tab').first().click()
  await startAgentInShownTerminal(dataHome, first.win, 2, `cd . && ${flags}`)
  await quitAndWait(first.app, first.win)

  const { app, win } = await launchAgentApp(dataHome, SESSION_PER_PANE)
  try {
    await expect.poll(() => resumedRuns().length, { timeout: 30_000 }).toBe(2)
    for (const run of resumedRuns()) {
      expect(run).toMatch(
        /^fake-agent-resumed --plugin-dir [^ ]+ --resume e2e-pane-\S+ --model Y --name Slack push --agent X --dangerously-skip-permissions GL=665#2 TOK=none END$/,
      )
    }
  } finally {
    await closeAsked(app, win)
  }
})

test('a /clear after an Ostia restart keeps the flags and variables the human typed', async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...AUTO_RESUME_SETTINGS, terminal: { keepShells: true } })
  const first = await launchAgentApp(dataHome, RESUME_ID, false, CLEARED_ID)
  await openWorkspace(first.win)
  await first.win.locator('.xterm').first().click()
  await first.win.keyboard.type(`GL_ISSUE='665#2' claude --agent X --dangerously-skip-permissions`)
  await first.win.keyboard.press('Enter')
  await expect(first.win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
    timeout: 15_000,
  })
  await expect.poll(() => agentRunningSaved(dataHome), { timeout: 15_000 }).toBe(true)
  await restartApp(first.app, first.win)

  const second = await launchAgentApp(dataHome, RESUME_ID)
  try {
    await expect(second.win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
      timeout: 15_000,
    })
    await second.win.locator('.xterm').first().click()
    await typeLine(second.win, '/clear')
    await expect
      .poll(() => (savedPanes(dataHome)[0].resume as { id?: string } | undefined)?.id, {
        timeout: 15_000,
      })
      .toBe(CLEARED_ID)
    expect(savedPanes(dataHome)[0].resume).toMatchObject({
      typed: {
        args: ['--agent', 'X', '--dangerously-skip-permissions'],
        env: { GL_ISSUE: '665#2' },
      },
    })
  } finally {
    await closeAsked(second.app, second.win)
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
