import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, expect } from '@playwright/test'

export function isolatedHome(dataHome: string): string {
  const home = join(dataHome, 'home')
  mkdirSync(home, { recursive: true })
  return home
}

const ECHO_AGENT = '#!/bin/sh\necho fake-agent-ready\nexec cat\n'

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
  await expect(win.locator('.xterm-rows').first()).toContainText(/[❯$%#]/, { timeout: 15_000 })
  await terminal.click()
  await win.keyboard.type('claude')
  await win.keyboard.press('Enter')
  await expect(win.locator('.xterm-rows').first()).toContainText('fake-agent-ready', {
    timeout: 15_000,
  })
}
