import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runInTerminal } from './helpers'
import { type Page, expect } from './test'

export const UPSTREAM_BODY = 'UPSTREAM-REACHED'

export async function fakeUpstream(): Promise<{
  server: Server
  url: string
  requested: string[]
}> {
  const requested: string[] = []
  const server = createServer((req, res) => {
    requested.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(UPSTREAM_BODY)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${port}`, requested }
}

export async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

export async function setSandbox(win: Page, on: boolean): Promise<void> {
  await win.locator('.rail-row').first().click({ button: 'right' })
  const item = win.getByRole('menuitemcheckbox', { name: 'Sandbox' })
  await expect(item).toHaveAttribute('aria-checked', on ? 'false' : 'true')
  await item.click()
}

export async function sandboxedShell(win: Page): Promise<void> {
  await setSandbox(win, true)
  const restart = win.getByRole('button', { name: 'Restart to apply' })
  await restart.click()
  await expect(restart).toHaveCount(0)
  const rows = win.locator('.xterm-rows').first()
  await expect(async () => {
    await runInTerminal(win, 'echo sandbox=${HTTPS_PROXY:+on}')
    await expect(rows).toContainText('sandbox=on', { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}
