import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { generate } from 'selfsigned'

export const FAKE_REGISTRY_HOSTS = ['registry.npmjs.org', 'api.osv.dev'] as const

const PUBLISHED = '2016-03-14T00:00:00.000Z'
const TARBALL = Buffer.from('fake left-pad tarball')

export interface FakeRegistry {
  port: number
  caPath: string
  close: () => Promise<void>
}

function reply(
  res: import('node:http').ServerResponse,
  status: number,
  type: string,
  body: Buffer | string,
): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

export async function startFakeRegistry(dir: string): Promise<FakeRegistry> {
  mkdirSync(dir, { recursive: true })
  const pems = await generate([{ name: 'commonName', value: FAKE_REGISTRY_HOSTS[0] }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: FAKE_REGISTRY_HOSTS.map((value) => ({ type: 2, value })),
      },
    ],
  })
  const caPath = join(dir, 'fake-registry-ca.pem')
  writeFileSync(caPath, pems.cert)
  const server: Server = createServer({ cert: pems.cert, key: pems.private }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]
    const path = req.url ?? ''
    if (host === 'api.osv.dev' && req.method === 'POST' && path === '/v1/query') {
      req.resume()
      req.on('end', () => reply(res, 200, 'application/json', '{}'))
    } else if (host === 'registry.npmjs.org' && path === '/left-pad') {
      reply(res, 200, 'application/json', JSON.stringify({ time: { '1.3.0': PUBLISHED } }))
    } else if (host === 'registry.npmjs.org' && path === '/left-pad/-/left-pad-1.3.0.tgz') {
      reply(res, 200, 'application/octet-stream', TARBALL)
    } else {
      reply(res, 404, 'text/plain', 'not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    caPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
