import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export interface MessagePageServer {
  url: (title: string, body: string) => string
  close: () => Promise<void>
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function messagePageHtml(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;height:100%;background:var(--pine-surface-1,#272a2d);color:var(--pine-fg,#e3edf5);font-family:var(--pine-font-ui,system-ui,sans-serif);font-size:var(--pine-font-size,13px);line-height:calc(var(--pine-font-size,13px) + 7px);font-weight:var(--pine-font-weight,400);color-scheme:var(--pine-color-scheme,dark)}
main{display:flex;flex-direction:column;justify-content:center;gap:8px;height:100%;max-width:560px;margin:0 auto;padding:0 24px}
h1{font-size:calc(var(--pine-font-size,13px) + 3px);line-height:calc(var(--pine-font-size,13px) + 9px);font-weight:calc(var(--pine-font-weight,400) + 200);margin:0}
p{margin:0;color:var(--pine-fg-muted,#9aa1a5);white-space:pre-wrap}
</style></head>
<body><main role="alert"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`
}

export async function startMessageServer(): Promise<MessagePageServer> {
  const secret = randomBytes(16).toString('hex')
  let port = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const ok =
      req.method === 'GET' &&
      req.headers.host === `127.0.0.1:${port}` &&
      url.pathname === '/message' &&
      url.searchParams.get('t') === secret
    if (!ok) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:",
      'x-content-type-options': 'nosniff',
    })
    res.end(
      messagePageHtml(url.searchParams.get('title') ?? '', url.searchParams.get('body') ?? ''),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  return {
    url: (title, body) =>
      `http://127.0.0.1:${port}/message?${new URLSearchParams({ t: secret, title, body })}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
