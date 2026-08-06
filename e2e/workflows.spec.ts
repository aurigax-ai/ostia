import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from '@playwright/test'
import { isolatedLaunch } from './dataHome'

/**
 * Core-workflow E2E for the pine terminal workspace. Each test launches its OWN built-app
 * instance (no single-instance lock; the control socket is per-PID) and closes it in a
 * `finally`, so a failure never leaks an Electron process. Serial via playwright.config
 * (workers: 1). Selectors were derived from the renderer source, favouring stable class
 * hooks (`.xterm`, `.pane`, `.file-row`) and `data-slot`/role over nth-child.
 */

interface Launched {
  app: ElectronApplication
  win: Page
}

/**
 * Launch the built app and wait for its first window to load. If window bring-up throws
 * after `electron.launch()` resolves, close the app before rethrowing so a failed launch
 * never leaks an Electron process.
 */
async function launchApp(): Promise<Launched> {
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    return { app, win }
  } catch (err) {
    await app.close()
    throw err
  }
}

/**
 * Wait until the shell has drawn its prompt into the (single, on-boot) terminal, so input
 * isn't typed into a not-yet-ready pty. Matches an actual prompt marker rather than "any
 * text" — this env's zsh/powerlevel10k prompt is "❯"; the character class also covers a
 * plain $ / % / # prompt on other shells. More reliable than a fixed sleep across shell
 * startup speeds. Reads the DOM renderer's `.xterm-rows`.
 */
async function waitForShellPrompt(win: Page): Promise<void> {
  const term = win.locator('.xterm').first()
  await expect(term).toBeVisible({ timeout: 15_000 })
  await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })
}

/** Deterministically wait for keyboard focus to land on xterm's hidden textarea. */
async function waitForTerminalFocus(win: Page): Promise<void> {
  await expect
    .poll(() =>
      win.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true)
}

/**
 * 1. Terminal spawns + runs a command. The command's OUTPUT (`pine_e2e_42`, from an
 *    arithmetic expansion) differs from what is TYPED (`...$((21+21))`), so a match proves
 *    the shell actually executed — not merely that our keystrokes were echoed onto the line.
 */
test('terminal spawns and runs a command', async () => {
  const { app, win } = await launchApp()
  try {
    await waitForShellPrompt(win)

    const term = win.locator('.xterm').first()
    await term.click() // focus the xterm hidden textarea
    await waitForTerminalFocus(win) // deterministic — no arbitrary sleep

    await win.keyboard.type('echo pine_e2e_$((21+21))')
    await win.keyboard.press('Enter')

    // The shell + OSC 133 shell-integration take a beat; poll generously.
    await expect(win.locator('.xterm-rows').first()).toContainText('pine_e2e_42', {
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})

/**
 * 2. Split a pane. Driven through the active pane's HEADER split-right button
 *    (`.pane.active .pane-actions .iconbtn` #1 → `pane.split` command), which the active
 *    pane always reveals (opacity:1 via `.pane.active .pane-actions`). This deliberately
 *    avoids the command palette, which is broken in the built app (see the parked test
 *    below). Terminal count 1 → 2.
 */
test('splitting a pane adds a second terminal', async () => {
  const { app, win } = await launchApp()
  try {
    await expect(win.locator('.xterm')).toHaveCount(1, { timeout: 15_000 })
    await expect(win.locator('.pane.active')).toBeVisible({ timeout: 15_000 })

    // The active pane header exposes [split-right, split-down, close]; #1 is split-right.
    const splitRight = win.locator('.pane.active .pane-actions .iconbtn').first()
    await splitRight.click()

    await expect(win.locator('.xterm')).toHaveCount(2, { timeout: 15_000 })
    await expect(win.locator('.pane')).toHaveCount(2)
  } finally {
    await app.close()
  }
})

/**
 * 3. Command palette. Opens with Ctrl+K (App.tsx global shortcut → `palette.toggle`),
 *    asserts the dialog, filters the list to a single matching command, and asserts the
 *    non-matching command is gone. Then runs `New Session` and confirms a sidebar session
 *    tab was added (rail count 1 → 2). Dialog = getByRole('dialog'); input =
 *    [data-slot="command-input"]; command rows show their title text.
 */
test('command palette opens, filters, and runs a command', async () => {
  const { app, win } = await launchApp()
  try {
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(1)

    await win.keyboard.press('Control+k')
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Filter: only the New Session command should remain matched.
    await win.locator('[data-slot="command-input"]').fill('New Session')
    await expect(dialog.getByText('New Session', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Split Pane Right', { exact: true })).toHaveCount(0)

    // Run it (Enter selects the single filtered row) and confirm a session tab was added.
    await win.keyboard.press('Enter')
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect(win.locator('.rail-tab')).toHaveCount(2, { timeout: 5_000 })
  } finally {
    await app.close()
  }
})

/**
 * 4. Open a file in the editor. Switch the sidebar to the Files view (2nd rail-switch
 *    button), click the first entry that is a FILE (a row with `.file-twisty-spacer`, not a
 *    directory twisty), and assert Monaco mounts. `.monaco-editor` appears as soon as the
 *    editor is created — it does not wait on file content — so this is timing-robust.
 *    (fs.list expands `~`, so the home dir populates even before OSC 7 cwd tracking fires;
 *    showHiddenFiles defaults to true, so dotfiles guarantee at least one file row.)
 */
test('opening a file shows the Monaco editor', async () => {
  const { app, win } = await launchApp()
  try {
    await expect(win.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    // No editor before we open a file — guards against a pre-existing Monaco false-green.
    await expect(win.locator('.monaco-editor')).toHaveCount(0)

    // Rail switcher: nth(0) = Sessions, nth(1) = Files.
    await win.locator('.rail-switch-btn').nth(1).click()

    // First entry that is a FILE (row has a spacer, not a directory twisty).
    const fileRow = win.locator('.file-row:has(.file-twisty-spacer)').first()
    await expect(fileRow).toBeVisible({ timeout: 10_000 })
    const fileName = (await fileRow.locator('.file-name').innerText()).trim()
    expect(fileName.length).toBeGreaterThan(0)
    await fileRow.click()

    // Monaco mounts...
    await expect(win.locator('.monaco-editor').first()).toBeVisible({ timeout: 15_000 })
    // ...for THAT file: openFile titles the new editor pane with the file's basename
    // (layoutStore.openFile → path.split('/').pop()). Assert an editor pane header shows it,
    // proving the clicked file — not just some editor — was opened. Scoped to `.pane-header`
    // so it can't match the identical name still shown in the Files sidebar.
    await expect(win.locator('.pane-header .title').filter({ hasText: fileName })).toBeVisible({
      timeout: 15_000,
    })
  } finally {
    await app.close()
  }
})
