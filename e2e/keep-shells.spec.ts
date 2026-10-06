import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, emptyState, emptyWorkspace, openWorkspace } from './helpers'

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

async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => {})
  await app.close().catch(() => {})
}

async function restart({ app, win }: Launched): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => undefined
  })
  const closed = app.waitForEvent('close')
  await win.evaluate(() => {
    void window.ostia.update.restart()
  })
  await closed
}

async function crash({ app }: Launched): Promise<void> {
  const closed = app.waitForEvent('close')
  app.process().kill('SIGKILL')
  await closed
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

async function savedLayout(_win: Page, panes = 1): Promise<void> {
  await expect.poll(() => savedPanes().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(panes)
}

async function run(win: Page, line: string, index = 0): Promise<void> {
  await win.locator('.xterm').nth(index).click()
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
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

const PARENT = 'echo parent=$(ps -o comm= -p $PPID)'

let dataHome: string

test.beforeEach(() => {
  dataHome = freshDataHome()
  seedSettings(dataHome, KEEP)
})

test('KSH-C7 a running command keeps running across Restart and finishes in its pane', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'sleep 4; echo kept-$((6*7))')
  await savedLayout(first.win)
  await restart(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('kept-42', { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C8 a running command survives Ostia being killed and is there after a relaunch', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'sleep 4; echo survived-$((6*7))')
  await savedLayout(first.win)
  await crash(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('survived-42', { timeout: 15_000 })
    await expect(screen(second.win)).toContainText(PROMPT)
  } finally {
    await quit(second.app)
  }
})

test('KSH-C1 with the setting off a terminal is a plain child of Ostia, with no tmux', async () => {
  seedSettings(dataHome, DOM_RENDERER_SETTINGS)
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(win, `${PARENT}; echo tmux=\${TMUX-none}`)
    await expect(screen(win)).toContainText('tmux=none', { timeout: 15_000 })
    await expect(screen(win)).toContainText(/parent=\S+/)
    await expect(screen(win)).not.toContainText(/parent=tmux/)
  } finally {
    await quit(app)
  }
})

test('KSH-C11 earlier commands come back as text and new commands get blocks', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'echo one-$((0+1))')
  await run(first.win, 'echo two-$((1+1))')
  await expect(first.win.locator('.block-gutter')).toHaveCount(2, { timeout: 15_000 })
  await savedLayout(first.win)
  await restart(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText('two-2', { timeout: 15_000 })
    await expect(screen(second.win)).toContainText('one-1')
    await expect(second.win.locator('.block-gutter')).toHaveCount(0)
    await run(second.win, 'echo three-$((2+1))')
    await expect(screen(second.win)).toContainText('three-3', { timeout: 15_000 })
    await expect(second.win.locator('.block-gutter')).toHaveCount(1, { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C13 the saved scrollback of a kept pane is not shown a second time', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'echo once-$((6*7))')
  await expect(screen(first.win)).toContainText('once-42', { timeout: 15_000 })
  await savedLayout(first.win)
  await restart(first)

  const second = await launch(dataHome)
  await expect(screen(second.win)).toContainText('once-42', { timeout: 15_000 })
  await quit(second.app)
  const saved = readFileSync(join(dataHome, 'ostia', 'scrollback.json'), 'utf8')
  expect(saved.split('once-42').length - 1).toBe(1)
})

async function newTerminal(win: Page): Promise<void> {
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
}

test('KSH-C20 with tmux gone a new terminal starts a plain shell and says it is not kept', async () => {
  const bin = binWith('tmux', '#!/bin/sh\necho "tmux 3.1"\n')
  const { app, win } = await launch(dataHome, pathWith(bin))
  try {
    await newTerminal(win)
    await expect(screen(win)).toContainText('tmux 3.2 or newer is not installed', {
      timeout: 15_000,
    })
    await expect(screen(win)).toContainText('This shell will not survive a restart')
    await expect(screen(win)).toContainText(PROMPT, { timeout: 15_000 })
    await run(win, `${PARENT}; echo plain-$((6*7))`)
    await expect(screen(win)).toContainText('plain-42', { timeout: 15_000 })
    await expect(screen(win)).not.toContainText('parent=tmux')
  } finally {
    await quit(app)
  }
})

test('KSH-C65 when tmux cannot start its server a new terminal starts a plain shell and says why', async () => {
  const bin = binWith(
    'tmux',
    '#!/bin/sh\nif [ "$1" = -V ]; then echo "tmux 3.4"; exit 0; fi\necho "server refused-$((6*7))" >&2\nexit 1\n',
  )
  const { app, win } = await launch(dataHome, pathWith(bin))
  try {
    await newTerminal(win)
    await expect(screen(win)).toContainText('tmux could not start its server: server refused-42', {
      timeout: 15_000,
    })
    await expect(screen(win)).toContainText('This shell will not survive a restart')
    await run(win, 'echo plain-$((6*7))')
    await expect(screen(win)).toContainText('plain-42', { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('KSH-C21 turning the setting off leaves a tmux pane running and the next terminal plain', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(win, `${PARENT}; sleep 3; echo still-$((2*2))`)
    await expect(screen(win)).toContainText('parent=tmux', { timeout: 15_000 })
    seedSettings(dataHome, DOM_RENDERER_SETTINGS)
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText(PROMPT, { timeout: 15_000 })
    await run(win, PARENT, 1)
    await expect(screen(win, 1)).toContainText(/parent=\S+/, { timeout: 15_000 })
    await expect(screen(win, 1)).not.toContainText('parent=tmux')
    await expect(screen(win)).toContainText('still-4', { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('KSH-C24 resizing a tmux pane at an idle prompt leaves one clean prompt line', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(win, 'echo before-resize')
    await expect(screen(win)).toContainText('before-resize', { timeout: 15_000 })
    for (const width of [1100, 1300, 1000]) {
      await app.evaluate(({ BrowserWindow }, w) => {
        BrowserWindow.getAllWindows()[0]?.setSize(w, 800)
      }, width)
      await win.waitForTimeout(400)
    }
    await expect
      .poll(async () => ((await screen(win).textContent()) ?? '').split('❯').length - 1, {
        timeout: 10_000,
      })
      .toBe(2)
    expect(await screen(win).textContent()).not.toMatch(/%\s*$/m)
    await run(win, 'clear; printf "%$(tput cols)s" "" | tr " " x; echo END')
    await expect
      .poll(() =>
        win
          .locator('.xterm-rows')
          .first()
          .locator(':scope > div')
          .evaluateAll((rows) => rows.some((row) => row.textContent?.startsWith('END'))),
      )
      .toBe(true)
  } finally {
    await quit(app)
  }
})

test('KSH-C26 blocks and the folder follow a tmux pane as they do a plain one', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(win, `${PARENT}; mkdir -p ~/proj && cd ~/proj && echo moved-$((1+1))`)
    await expect(screen(win)).toContainText('parent=tmux', { timeout: 15_000 })
    await expect(win.locator('.block-gutter')).toHaveCount(1, { timeout: 15_000 })
    await win.locator('.pane.active').getByRole('button', { name: 'Split right' }).click()
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(screen(win, 1)).toContainText('~/proj ❯', { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('KSH-C27 ostia pane send types into a tmux pane with the usual rules', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await run(win, 'ostia process run "cat" --name echo')
    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await run(
      win,
      'until ostia process ls | grep -q running; do sleep 0.2; done; ostia pane send echo "sum-$((20+3))" --enter; sleep 1; ostia pane read echo',
    )
    await expect(screen(win)).toContainText('sum-23', { timeout: 30_000 })
  } finally {
    await quit(app)
  }
})

test('KSH-C31 with clipboard writes off a program in a tmux pane cannot set the clipboard', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'))
    await run(
      win,
      'printf \'\\033]52;c;%s\\a\' "$(printf ostia-osc52-tmux | base64)"; echo osc-sent',
    )
    await expect(screen(win)).toContainText('osc-sent', { timeout: 15_000 })
    await win.waitForTimeout(300)
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('before')
  } finally {
    await quit(app)
  }
})

test('KSH-C32 ostia whoami in a kept pane answers with the same pane after a restart', async () => {
  const who = `"$(ostia whoami | grep -o '"paneId": "[^"]*"' | cut -d'"' -f4)"`
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, `echo "shell=$$ who=${who}"`)
  await expect(screen(first.win)).toContainText(/shell=\d+ who=\S+/, { timeout: 15_000 })
  const [, pid, pane] =
    /shell=(\d+) who=(\S+)/.exec((await screen(first.win).textContent()) ?? '') ?? []
  await savedLayout(first.win)
  await restart(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await run(second.win, `clear; echo "again=$$ who=${who}"`)
    await expect(screen(second.win)).toContainText(`again=${pid} who=${pane}`, {
      timeout: 15_000,
    })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C33 a kept pane runs the CLI of the Ostia that is running now', async () => {
  const { app, win } = await launch(dataHome)
  try {
    await openWorkspace(win)
    const execPath = await app.evaluate(() => process.execPath)
    await run(win, 'echo "cli=$OSTIA_CLI"; cat "$OSTIA_NODE"')
    await expect(screen(win)).toContainText(join(dataHome, 'userData', 'bin', 'ostia-cli.js'), {
      timeout: 15_000,
    })
    await expect(screen(win)).toContainText(execPath)
  } finally {
    await quit(app)
  }
})

test('KSH-C34 no file on disk holds a kept pane token, before or after a restart', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await savedLayout(first.win)
  await restart(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await run(
      second.win,
      `grep -rlF -- "$OSTIA_TOKEN" ${join(dataHome, 'userData')} ${join(dataHome, 'ostia')} "\${TMPDIR:-/tmp}"/ostia-* 2>/dev/null; echo "token-files=$(grep -rlF -- "$OSTIA_TOKEN" ${dataHome} "\${TMPDIR:-/tmp}"/ostia-* 2>/dev/null | wc -l)"`,
    )
    await expect(screen(second.win)).toContainText('token-files=0', { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C35 calling ostia while Ostia is closed fails cleanly and the shell stays', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'sleep 2; ostia whoami; echo "rc=$?"')
  await savedLayout(first.win)
  await crash(first)
  await new Promise((r) => setTimeout(r, 4000))

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText(/rc=[1-9]/, { timeout: 15_000 })
    await run(second.win, 'echo alive-$((3*3))')
    await expect(screen(second.win)).toContainText('alive-9', { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C36 an agent still running after a restart stays marked and is never resumed over', async () => {
  seedSettings(dataHome, { ...KEEP, agents: { autoResume: true } })
  const bin = binWith(
    'claude',
    [
      '#!/bin/sh',
      'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude e2e-kept-1 >/dev/null 2>&1',
      'echo fake-agent-ready',
      'exec cat',
      '',
    ].join('\n'),
  )
  const first = await launch(dataHome, pathWith(bin))
  await openWorkspace(first.win)
  await run(first.win, 'claude')
  await expect(screen(first.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
  await expect
    .poll(() => savedPanes().some((p) => p.agentRunning === true), { timeout: 15_000 })
    .toBe(true)
  await restart(first)

  const second = await launch(dataHome, pathWith(bin))
  try {
    await expect(screen(second.win)).toContainText('fake-agent-ready', { timeout: 15_000 })
    await second.win.waitForTimeout(1500)
    expect(savedPanes().some((p) => p.agentRunning === true)).toBe(true)
    await second.win.locator('.xterm').first().click()
    await second.win.keyboard.press('Control+D')
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await second.win.waitForTimeout(2000)
    await expect(screen(second.win)).not.toContainText('--resume')
  } finally {
    await quit(second.app)
  }
})

test('KSH-C37 a process tab is still listed after a restart and can still be killed', async () => {
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'ostia process run "sleep 60" --name demo')
  await expect(first.win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
  await run(first.win, 'until ostia process ls | grep -q running; do sleep 0.2; done; echo started')
  await expect(screen(first.win)).toContainText('started', { timeout: 15_000 })
  await savedLayout(first.win, 2)
  await restart(first)

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await run(second.win, 'clear; ostia process ls')
    await expect(screen(second.win)).toContainText(/demo\s+running/, { timeout: 15_000 })
    await run(second.win, 'ostia process kill demo && ostia process ls')
    await expect(screen(second.win)).toContainText(/demo\s+exited/, { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})

test('KSH-C38 waking a hibernated agent with the setting on starts a fresh window and resumes', async () => {
  test.setTimeout(90_000)
  seedSettings(dataHome, {
    ...KEEP,
    agents: { hibernation: { enabled: true, idleSeconds: 5, maxLiveTerminals: 0 } },
  })
  const bin = binWith('claude', '#!/bin/sh\necho "fake agent up: $*"\nexec sleep 600\n')
  const { app, win } = await launch(dataHome, pathWith(bin))
  try {
    await openWorkspace(win)
    await run(win, 'ostia resume-token claude e2e-kept-tok')
    await expect(win.getByRole('button', { name: 'Resume claude' })).toBeVisible({
      timeout: 15_000,
    })
    await run(win, PARENT)
    await expect(screen(win)).toContainText('parent=tmux', { timeout: 15_000 })
    await run(win, 'claude')
    await expect(screen(win)).toContainText('fake agent up:', { timeout: 15_000 })
    await win.getByRole('button', { name: 'New terminal tab' }).click()
    await expect(win.getByRole('tab')).toHaveCount(2)
    const sleeping = win.getByRole('tab').first()
    await expect(sleeping.getByLabel('Hibernated')).toBeVisible({ timeout: 30_000 })
    await sleeping.click()
    await win.locator('.hibernated-view').getByRole('button', { name: 'Resume claude' }).click()
    const rows = win.locator('.pane-slot:not([data-hidden]) .xterm-rows')
    await expect(rows).toContainText(/fake agent up: .*--resume e2e-kept-tok/, { timeout: 15_000 })
  } finally {
    await quit(app)
  }
})

test('KSH-C41 a kept shell waits while Ostia is closed and is the same shell when it returns', async () => {
  test.setTimeout(60_000)
  const first = await launch(dataHome)
  await openWorkspace(first.win)
  await run(first.win, 'echo "shell=$$"')
  await expect(screen(first.win)).toContainText(/shell=\d+/, { timeout: 15_000 })
  const pid = /shell=(\d+)/.exec((await screen(first.win).textContent()) ?? '')?.[1]
  await savedLayout(first.win)
  await crash(first)
  await new Promise((r) => setTimeout(r, 5000))
  expect(() => process.kill(Number(pid), 0)).not.toThrow()

  const second = await launch(dataHome)
  try {
    await expect(screen(second.win)).toContainText(PROMPT, { timeout: 15_000 })
    await run(second.win, 'clear; echo "again=$$"')
    await expect(screen(second.win)).toContainText(`again=${pid}`, { timeout: 15_000 })
  } finally {
    await quit(second.app)
  }
})
