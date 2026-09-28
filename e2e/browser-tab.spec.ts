import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'

test('a browser tab shows why a page failed, then loads a page and takes its title', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end('<title>Pine test page</title><h1>hello pine</h1>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  const closed = createServer()
  await new Promise<void>((ready) => closed.listen(0, '127.0.0.1', ready))
  const deadPort = (closed.address() as AddressInfo).port
  await new Promise<void>((done) => closed.close(() => done()))

  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')

    await address.fill(`http://127.0.0.1:${deadPort}/`)
    await address.press('Enter')
    const error = win.getByRole('alert')
    await expect(error).toContainText('This page couldn’t load', { timeout: 15_000 })
    await expect(error).toContainText(`127.0.0.1:${deadPort}`)

    await address.fill(`http://127.0.0.1:${port}/`)
    await address.press('Enter')
    await expect(error).toHaveCount(0, { timeout: 15_000 })
    await expect(win.getByRole('tab', { name: /Pine test page/ })).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
    server.close()
  }
})
