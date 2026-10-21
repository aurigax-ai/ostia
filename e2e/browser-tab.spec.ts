import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedLaunch } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-e2e-cert-'))
  try {
    const key = join(dir, 'key.pem')
    const cert = join(dir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=accounts.google.com',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a browser tab sends the Electron agent only to Google sign-in hosts and the Chrome one again right after', async () => {
  const agents = new Map<string, string>()
  const page = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    agents.set(`${url.hostname}${url.pathname}`, req.headers['user-agent'] ?? '')
    if (url.pathname === '/to-signin') {
      res.writeHead(302, { location: 'https://accounts.google.com/signin' })
      res.end()
      return
    }
    const name = url.pathname.slice(1)
    res.setHeader('content-type', 'text/html')
    res.end(
      `<title>${name}</title>` +
        `<script>document.title = '${name} ' + (/Electron/.test(navigator.userAgent) ? 'js-electron' : 'js-chrome')</script>`,
    )
  }
  const plain = createServer(page)
  await new Promise<void>((ready) => plain.listen(0, '127.0.0.1', ready))
  const { port } = plain.address() as AddressInfo
  const signin = createTlsServer(selfSignedCert(), page)
  await new Promise<void>((ready) => signin.listen(0, '127.0.0.1', ready))
  const tlsPort = (signin.address() as AddressInfo).port

  const launch = isolatedLaunch()
  const app = await electron.launch({
    ...launch,
    args: [
      `--host-resolver-rules=MAP accounts.google.com 127.0.0.1:${tlsPort}`,
      '--ignore-certificate-errors',
      ...launch.args,
    ],
  })
  try {
    const win = await app.firstWindow()
    await openWorkspace(win)
    await win.getByRole('button', { name: 'New browser tab' }).click()
    const address = win.locator('.pane-slot:not([data-hidden]) .browser-address')
    const visit = async (url: string, title: string): Promise<void> => {
      await address.fill(url)
      await address.press('Enter')
      await expect(win.getByRole('tab', { name: new RegExp(title) })).toBeVisible({
        timeout: 15_000,
      })
    }

    await visit(`http://127.0.0.1:${port}/before`, 'before js-chrome')
    await visit(`http://127.0.0.1:${port}/to-signin`, 'signin js-electron')
    await visit(`http://127.0.0.1:${port}/after`, 'after js-chrome')

    const chrome = expect.stringMatching(/^(?!.*(Electron|ostia)).*Chrome\/\d+/i)
    const electronAgent = expect.stringMatching(/Electron\/\d+/)
    expect(Object.fromEntries(agents)).toMatchObject({
      '127.0.0.1/before': chrome,
      '127.0.0.1/to-signin': chrome,
      'accounts.google.com/signin': electronAgent,
      '127.0.0.1/after': chrome,
    })
  } finally {
    await app.close()
    plain.close()
    signin.close()
  }
})
