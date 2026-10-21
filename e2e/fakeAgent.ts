import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPT } from './helpers'
import { expect, type Page } from './test'

export function isolatedHome(dataHome: string): string {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  return home
}

export const REPORT_SESSION =
  'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" resume-token claude "e2e-fake-$$" >/dev/null 2>&1'

const ECHO_AGENT = `#!/bin/sh\n${REPORT_SESSION}\necho fake-agent-ready\nexec cat\n`

export function fakeAgentBin(dataHome: string, script: string = ECHO_AGENT): string {
  const bin = join(dataHome, 'bin')
  mkdirSync(bin, { recursive: true })
  const claude = join(bin, 'claude')
  writeFileSync(claude, script)
  chmodSync(claude, 0o755)
  return bin
}

export async function startFakeAgent(win: Page): Promise<void> {
  const terminal = win.locator('.xterm').first()
  await expect(win.locator('.xterm-rows').first()).toContainText(PROMPT, { timeout: 15_000 })
  await terminal.click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
    timeout: 15_000,
  })
}
