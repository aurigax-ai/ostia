import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEPT_SHELLS_DIR } from '../src/shared/terminal/keepShells'
import { chords } from './chords'
import {
  DOM_RENDERER_SETTINGS,
  freshDataHome,
  HIBERNATE_FAST,
  isolatedLaunch,
  seedSettings,
} from './dataHome'
import { fakeAgentBin } from './fakeAgent'
import {
  newTerminal,
  newTerminalWorkspace,
  occurrences,
  openWorkspace,
  PROMPT,
  pressQuit,
  quitApp,
  restartApp,
  runInTerminal,
  shownTerminal,
  typeLine,
} from './helpers'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  killApp,
  type Page,
  test,
  waitForExit,
} from './test'

const KEEP = { ...DOM_RENDERER_SETTINGS, terminal: { keepShells: true } }

interface Launched {
  app: ElectronApplication
  win: Page
}

async function launch(dataHome: string, env: Record<string, string> = {}): Promise<Launched> {
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...options, env: { ...options.env, ...env } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

async function crash({ app }: Launched): Promise<void> {
  await killApp(app)
}

function savedPanes(): Record<string, unknown>[] {
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

async function savedLayout(panes = 1): Promise<void> {
  await expect.poll(() => savedPanes().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(panes)
}

function screen(win: Page, index = 0) {
  return win.locator('.xterm-rows').nth(index)
}

function binWith(name: string, script: string): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), script)
  chmodSync(join(bin, name), 0o755)
  return bin
}

function pathWith(bin: string): Record<string, string> {
  return { PATH: `${bin}:${process.env.PATH ?? ''}` }
}

const PARENT = 'echo parent=$(basename "$(ps -o comm= -p $PPID)")'

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
  seedSettings(dataHome, KEEP)
})

test('KSH-C7 KSH-C13 KSH-C27 KSH-C32 KSH-C37 KSH-C72 a kept shell comes back after Restart with its running command, one copy of its saved scrollback, the same pane, a new token and a process tab that takes text and can be killed', async () => {
  const who = `"$(ostia whoami | grep -o '"paneId":"[^"]*"' | cut -d'"' -f4)"`
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await runInTerminal(first.win, `echo "shell=$$ who=${who};"`)
  await expect(screen(first.win)).toContainText(/shell=\d+ who=[^;\s]+;/, { timeout: 15_000 })
  await runInTerminal(
    first.win,
    'echo "before=$(cat "$OSTIA_TOKEN_FILE") env=${OSTIA_TOKEN:-none}"',
  )
  await expect(screen(first.win)).toContainText(/before=[0-9a-f]{64} env=none/, {
    timeout: 15_000,
  })
  const text = (await screen(first.win).textContent()) ?? ''
  const [, pid, pane] = /shell=(\d+) who=([^;\s]+);/.exec(text) ?? []
  const [, before] = /before=([0-9a-f]{64})/.exec(text) ?? []
  await runInTerminal(first.win, 'ostia process run "cat" --name demo')
  await expect(first.win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
  await runInTerminal(
    first.win,
    'until ostia process list | grep -q running; do sleep 0.2; done; echo started',
  )
  await expect(screen(first.win)).toContainText('started', { timeout: 15_000 })
  await runInTerminal(first.win, 'echo once-$((6*7)); sleep 4; echo kept-$((6*7))')
  await expect(screen(first.win)).toContainText('once-42', { timeout: 15_000 })
  await savedLayout(2)
  await restartApp(first.app, first.win)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('kept-42', { timeout: 15_000 })
    await runInTerminal(
      second.win,
      `t=$(cat "$OSTIA_TOKEN_FILE"); echo "again=$$ who=${who} others=$(grep -rlF -- "$t" ${dataHome} "\${TMPDIR:-/tmp}"/ostia-* 2>/dev/null | grep -vxF "$OSTIA_TOKEN_FILE" | wc -l | tr -d ' ') same=$([ "$t" = "${before}" ] && echo yes || echo no)"`,
    )
    await expect(screen(second.win)).toContainText(`again=${pid} who=${pane} others=0 same=no`, {
      timeout: 15_000,
    })
    await runInTerminal(second.win, 'ostia process list')
    await expect(screen(second.win)).toContainText(/demo\s+running/, { timeout: 15_000 })
    await runInTerminal(
      second.win,
      'ostia pane send demo "sum-$((20+3))" --enter; until ostia pane read demo | grep -q sum-23; do sleep 0.2; done; echo read-ok-$((6*7))',
    )
    await expect(screen(second.win)).toContainText('read-ok-42', { timeout: 30_000 })
    await runInTerminal(second.win, 'ostia process kill demo && ostia process list')
    await expect(screen(second.win)).toContainText(/demo\s+exited/, { timeout: 15_000 })
  } finally {
    await quitApp(second.app)
  }
  const saved = readFileSync(join(dataHome, 'ostia', 'scrollback.json'), 'utf8')
  expect(occurrences(saved, 'once-42')).toBe(1)
})

test('KSH-C8 KSH-C41 a kept shell runs its command while Ostia is closed and is the same shell when it returns', async () => {
  test.setTimeout(60_000)
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'echo "shell=$$"; sleep 4; echo survived-$((6*7))')
  await expect(screen(first.win)).toContainText(/shell=\d+/, { timeout: 15_000 })
  const pid = /shell=(\d+)/.exec((await screen(first.win).textContent()) ?? '')?.[1]
  await savedLayout()
  await crash(first)
  expect(() => process.kill(Number(pid), 0)).not.toThrow()

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('survived-42', { timeout: 15_000 })
    await expect(screen(second.win)).toContainText(PROMPT)
    await runInTerminal(second.win, 'echo "again=$$"')
    await expect(screen(second.win)).toContainText(`again=${pid}`, { timeout: 15_000 })
  } finally {
    await quitApp(second.app)
  }
})

test('KSH-C20 with tmux gone a new terminal starts a plain shell and says it is not kept', async () => {
  const bin = binWith('tmux', '#!/bin/sh\necho "tmux 3.1"\n')
  const { app, win } = await launch(dataHome, pathWith(bin))
  try {
    await newTerminal(win)
    await expect(screen(win)).toContainText('This shell will not survive a restart', {
      timeout: 15_000,
    })
    await expect(screen(win)).toContainText(PROMPT, { timeout: 15_000 })
    await runInTerminal(win, `${PARENT}; echo plain-$((6*7))`)
    await expect(screen(win)).toContainText('plain-42', { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('parent=tmux')
  } finally {
    await quitApp(app)
  }
})

test('KSH-C91 started with the bare PATH a desktop launch gives, Ostia keeps shells with the tmux on the login shell PATH', async () => {
  const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
  const log = join(dataHome, 'tmux-calls')
  const bin = binWith('tmux', `#!/bin/sh\necho "$1" >> '${log}'\nexec '${realTmux}' "$@"\n`)
  const loginDir = join(dataHome, 'login-shell')
  mkdirSync(loginDir, { recursive: true })
  const shell = join(loginDir, 'bash')
  writeFileSync(
    shell,
    `#!/bin/bash\nif [ "$1" = -ilc ]; then export PATH='${bin}:/usr/bin:/bin':"$PATH"; fi\nexec /bin/bash "$@"\n`,
  )
  chmodSync(shell, 0o755)
  const empty = join(dataHome, 'empty-path')
  mkdirSync(empty, { recursive: true })
  const bare = process.platform === 'darwin' ? '/usr/bin:/bin:/usr/sbin:/sbin' : empty
  const { app, win } = await launch(dataHome, { PATH: bare, SHELL: shell })
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'echo kept=${OSTIA_TOKEN_FILE:+yes}')
    await expect(screen(win)).toContainText('kept=yes', { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('This shell will not survive a restart')
    if (process.platform !== 'darwin') expect(readFileSync(log, 'utf8')).not.toBe('')
  } finally {
    await quitApp(app)
  }
})

test('KSH-C21 turning the setting off leaves a tmux pane running and the next terminal plain', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await runInTerminal(win, `${PARENT}; sleep 3; echo still-$((2*2))`)
    await expect(screen(win)).toContainText('parent=tmux', { timeout: 15_000 })
    seedSettings(dataHome, DOM_RENDERER_SETTINGS)
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText(PROMPT, { timeout: 15_000 })
    await runInTerminal(win, PARENT, win.locator('.xterm').nth(1))
    await expect(screen(win, 1)).toContainText(/parent=\S+/, { timeout: 15_000 })
    await expect(screen(win, 1)).not.toContainText('parent=tmux')
    await expect(screen(win)).toContainText('still-4', { timeout: 15_000 })
  } finally {
    await quitApp(app)
  }
})

test('KSH-C87 the state an agent last reported is shown again after a restart', async () => {
  const cli = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
  const bin = fakeAgentBin(
    dataHome,
    [
      '#!/bin/sh',
      `${cli} state waiting "Approve the plan?" >/dev/null 2>&1`,
      'echo fake-agent-ready',
      'exec cat',
      '',
    ].join('\n'),
  )
  const first = await launch(dataHome, pathWith(bin))
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'claude')
  await expect(screen(first.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await expect(first.win.locator('.workspace-dot').first()).toHaveAttribute(
    'aria-label',
    'Waiting for input',
    { timeout: 15_000 },
  )
  await savedLayout()
  await restartApp(first.app, first.win)

  const second = await launch(dataHome, pathWith(bin))
  try {
    await expect(screen(second.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
    await expect(second.win.locator('.workspace-dot').first()).toHaveAttribute(
      'aria-label',
      'Waiting for input',
      { timeout: 15_000 },
    )
    await expect(second.win.locator('.pane-tab[data-attention="waiting"]')).toHaveCount(1)
  } finally {
    await quitApp(second.app)
  }
})

test('KSH-C86 what an agent hook reports while Ostia is closed is shown once Ostia is back', async () => {
  test.setTimeout(90_000)
  const cli = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
  const trigger = join(dataHome, 'ask-now')
  const payload = JSON.stringify({ notification_type: 'permission_prompt', message: 'Run deploy?' })
  const bin = fakeAgentBin(
    dataHome,
    [
      '#!/bin/sh',
      'echo fake-agent-ready',
      `while [ ! -e ${trigger} ]; do sleep 0.2; done`,
      `echo '${payload}' | ${cli} claude-hook Notification`,
      'echo "hook-rc=$?"',
      'exec cat',
      '',
    ].join('\n'),
  )
  const first = await launch(dataHome, pathWith(bin))
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'claude')
  await expect(screen(first.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await expect(first.win.locator('.pane-tab[data-attention]')).toHaveCount(0)
  await savedLayout()
  await crash(first)

  const tokens = join(dataHome, 'userData', KEPT_SHELLS_DIR, 'tokens')
  const stateFiles = (): string[] =>
    readdirSync(tokens, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.state'))
      .map((name) => join(tokens, name))
  expect(stateFiles().map((file) => readFileSync(file, 'utf8'))).toEqual([''])
  writeFileSync(trigger, '')
  await expect
    .poll(() => stateFiles().map((file) => readFileSync(file, 'utf8')), { timeout: 15_000 })
    .toEqual([JSON.stringify({ state: 'waiting', message: 'Run deploy?' })])

  const second = await launch(dataHome, pathWith(bin))
  try {
    await expect(screen(second.win)).toContainText('hook-rc=0', { timeout: 15_000 })
    await expect(second.win.locator('.workspace-dot').first()).toHaveAttribute(
      'aria-label',
      'Waiting for input',
      { timeout: 15_000 },
    )
    await expect(second.win.locator('.pane-tab[data-attention="waiting"]')).toHaveCount(1)
  } finally {
    await quitApp(second.app)
  }
})

test('KSH-C67 text sent to an agent that kept running across a restart waits for its next report, then pastes', async () => {
  test.setTimeout(90_000)
  const cli = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
  const bin = fakeAgentBin(
    dataHome,
    [
      '#!/bin/sh',
      "printf '\\033[?2004h'",
      `${cli} resume-token claude e2e-kept-2 >/dev/null 2>&1`,
      'echo "agent-pane=$OSTIA_PANE_ID"',
      'echo fake-agent-ready',
      'read answer',
      `${cli} state working >/dev/null 2>&1`,
      'echo "reported-$((2+2))"',
      'stty raw -echo',
      'exec cat -v',
      '',
    ].join('\n'),
  )
  const first = await launch(dataHome, pathWith(bin))
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'claude')
  await expect(screen(first.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
  const firstScreen = (await screen(first.win).textContent()) ?? ''
  const agentPane = /agent-pane=([0-9a-f-]{36})/.exec(firstScreen)?.[1]
  expect(agentPane).toBeTruthy()
  await expect
    .poll(() => savedPanes().some((p) => p.agentRunning === true), { timeout: 15_000 })
    .toBe(true)
  await restartApp(first.app, first.win)

  const second = await launch(dataHome, pathWith(bin))
  try {
    const { win } = second
    await expect(screen(win)).toContainText('fake-agent-ready', { timeout: 15_000 })
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText(PROMPT, { timeout: 15_000 })
    await runInTerminal(
      win,
      `ostia pane send ${agentPane} typed-early; echo "text-rc=$?"`,
      win.locator('.xterm').nth(1),
    )
    const card = win.getByRole('region', { name: 'Agent permission request' })
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'More ways to allow' }).click()
    await win.getByRole('menuitem', { name: 'Allow for this pane' }).click()
    await expect(screen(win, 1)).toContainText('agent-waiting', { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText(/text-rc=[1-9]/)
    await expect(screen(win)).not.toContainText('typed-early')
    await runInTerminal(win, `ostia pane key ${agentPane} enter`, win.locator('.xterm').nth(1))
    await expect(screen(win)).toContainText('reported-4', { timeout: 15_000 })
    await runInTerminal(
      win,
      `ostia pane send ${agentPane} "after-$((3*3))"`,
      win.locator('.xterm').nth(1),
    )
    await expect(screen(win)).toContainText('after-9', { timeout: 15_000 })
    await runInTerminal(
      win,
      `ostia pane send ${agentPane} "$(printf 'line-%s\\n' 1 2)"`,
      win.locator('.xterm').nth(1),
    )
    await expect(screen(win)).toContainText('^[[200~line-1^Mline-2^[[201~', { timeout: 15_000 })
  } finally {
    await quitApp(second.app)
  }
})

test('KSH-C38 waking a hibernated agent with the setting on starts a fresh window and resumes', async () => {
  test.setTimeout(90_000)
  seedSettings(dataHome, {
    ...KEEP,
    agents: { hibernation: HIBERNATE_FAST },
  })
  const bin = fakeAgentBin(
    dataHome,
    '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-kept-tok >/dev/null 2>&1\necho "fake agent up: $*"\nexec sleep 600\n',
  )
  const { app, win } = await launch(dataHome, pathWith(bin))
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'ostia resume-token claude e2e-kept-tok && echo token-$((6*7))')
    await expect(screen(win)).toContainText('token-42', { timeout: 15_000 })
    await runInTerminal(win, PARENT)
    await expect(screen(win)).toContainText('parent=tmux', { timeout: 15_000 })
    await runInTerminal(win, 'claude')
    await expect(screen(win)).toContainText('fake agent up:', { timeout: 15_000 })
    await win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(win.getByRole('tab')).toHaveCount(2)
    const sleeping = win.getByRole('tab').first()
    await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 30_000 })
    await sleeping.click()
    await win.locator('.hibernated-view').click()
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText(/fake agent up: .*--resume e2e-kept-tok/, { timeout: 15_000 })
  } finally {
    await quitApp(app)
  }
})

test('KSH-C88 a kept program in a workspace that is not open is attached again by Restart before the workspace is opened', async () => {
  test.setTimeout(60_000)
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'echo "file=$OSTIA_TOKEN_FILE shell=$$"; cat')
  await expect(screen(first.win)).toContainText(/file=\S+ shell=\d+/, { timeout: 15_000 })
  const [, file, pid] =
    /file=(\S+) shell=(\d+)/.exec((await screen(first.win).textContent()) ?? '') ?? []
  const before = readFileSync(file, 'utf8')
  await newTerminalWorkspace(first.win)
  await savedLayout(2)
  await expect.poll(savedActiveIsNewest, { timeout: 15_000 }).toBe(true)
  await restartApp(first.app, first.win)
  expect(() => process.kill(Number(pid), 0)).not.toThrow()

  const second = await launch(dataHome)
  try {
    await expect(shownTerminal(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await expect(second.win.locator('.workzone-workspace')).toHaveCount(1)
    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 }).not.toBe(before)
    expect(() => process.kill(Number(pid), 0)).not.toThrow()
    await second.win.keyboard.press(chords.firstWorkspace)
    await expect(shownTerminal(second.win)).toContainText(`shell=${pid}`, { timeout: 15_000 })
    await shownTerminal(second.win).click()
    await typeLine(second.win, 'kept-input')
    await expect
      .poll(async () =>
        occurrences((await shownTerminal(second.win).textContent()) ?? '', 'kept-input'),
      )
      .toBeGreaterThanOrEqual(2)
  } finally {
    await quitApp(second.app)
  }
})

function savedActiveIsNewest(): boolean {
  const file = join(dataHome, 'ostia', 'workspaces.json')
  if (!existsSync(file)) return false
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  return saved.workspaces.length === 2 && saved.activeWorkspaceId === saved.workspaces[1].id
}

function agentMidTurn(trigger: string): string {
  return fakeAgentBin(
    dataHome,
    [
      '#!/bin/sh',
      'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-kept-2 >/dev/null 2>&1',
      'echo fake-agent-booted',
      `while [ ! -e ${trigger} ]; do sleep 0.2; done`,
      'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" state working >/dev/null 2>&1',
      'echo fake-agent-ready',
      'exec cat',
      '',
    ].join('\n'),
  )
}

const KEEP_AND_ASK = {
  ...KEEP,
  agents: { autoResume: true },
  workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, confirmQuit: true },
}

async function endUnattended(app: ElectronApplication): Promise<void> {
  await killApp(app, 'SIGTERM')
}

test('KSH-C36 KSH-C70 KSH-C103 an agent still mid-turn after a restart asks nothing, stays marked, is named by pane list and is never resumed over', async () => {
  seedSettings(dataHome, KEEP_AND_ASK)
  const trigger = join(dataHome, 'start-turn')
  const bin = agentMidTurn(trigger)
  const listAgents = `ostia pane list --json | tr -d ' \\n' | grep -o '"agent":"[a-z]*"' | sed 's/^/listed-/'`
  const first = await launch(dataHome, pathWith(bin))
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'claude')
  await expect(screen(first.win)).toContainText('fake-agent-booted', { timeout: 15_000 })
  await expect
    .poll(() => savedPanes().some((p) => p.agentRunning === true), { timeout: 15_000 })
    .toBe(true)
  writeFileSync(trigger, '')
  await expect(screen(first.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await restartApp(first.app, first.win)

  const second = await launch(dataHome, pathWith(bin))
  try {
    const { win } = second
    await expect(screen(win)).toContainText('fake-agent-ready', { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('--resume')
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText(PROMPT, { timeout: 15_000 })
    await runInTerminal(win, listAgents, win.locator('.xterm').nth(1))
    await expect(screen(win, 1)).toContainText('listed-"agent":"claude"', { timeout: 15_000 })
    await win.locator('.xterm').first().click()
    await typeLine(win, 'agent-alive')
    await expect(screen(win)).toContainText('agent-alive', { timeout: 15_000 })
    await expect
      .poll(() => savedPanes().some((p) => p.agentRunning === true), { timeout: 15_000 })
      .toBe(true)
    await win.keyboard.press('Control+D')
    await expect(screen(win)).toContainText(PROMPT, { timeout: 15_000 })
    await runInTerminal(win, 'echo after-$((6*7))', win.locator('.xterm').first())
    await expect(screen(win)).toContainText('after-42', { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('--resume')
  } finally {
    await endUnattended(second.app)
  }
})

function keptSocket(): string {
  const userData = join(dataHome, 'userData')
  const name = createHash('sha256').update(userData).digest('hex').slice(0, 16)
  return join(userData, KEPT_SHELLS_DIR, name)
}

async function quitChoosing(launched: Launched, button: string): Promise<void> {
  expect(await pressQuit(launched.app, launched.win)).toBe('asked')
  const dialog = launched.win.getByRole('dialog')
  await expect(dialog).toContainText('1 kept shell is running')
  const exited = waitForExit(launched.app)
  await dialog.getByRole('button', { name: button }).click()
  await exited
}

test('KSH-C102 Quit and keep shells leaves a running command alive, and the next start shows it finish', async () => {
  seedSettings(dataHome, KEEP_AND_ASK)
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await runInTerminal(first.win, 'sleep 5; echo quit-kept-$((6*7))')
  await savedLayout()
  await quitChoosing(first, 'Quit and keep shells')
  expect(existsSync(keptSocket())).toBe(true)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('quit-kept-42', { timeout: 15_000 })
    await expect(screen(second.win)).toContainText(PROMPT)
  } finally {
    await endUnattended(second.app)
  }
})

test('KSH-C110 a kept pane stays open and keeps printing when tmux ends its control client', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'i=0; while :; do echo wake-$i; i=$((i+1)); sleep 0.2; done')
    await expect(screen(win)).toContainText('wake-3', { timeout: 15_000 })
    const tmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim()
    const pids = execFileSync(
      tmux,
      ['-u', '-S', keptSocket(), 'list-clients', '-F', '#{client_pid}'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
    expect(pids.length).toBe(1)
    process.kill(Number(pids[0]), 'SIGKILL')
    await expect(screen(win)).toContainText('wake-', { timeout: 15_000 })
    const seen = (await screen(win).textContent()) ?? ''
    const last = Math.max(...[...seen.matchAll(/wake-(\d+)/g)].map((m) => Number(m[1])))
    await expect(screen(win)).toContainText(`wake-${last + 10}`, { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('[process exited]')
  } finally {
    await quitApp(app)
  }
})
