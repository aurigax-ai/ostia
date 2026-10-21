import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROJECT = 'ostia-e2e'
const ACCESS_TOKEN = 'fake-access-token'
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

interface FcmMessage {
  authorized: boolean
  body: { message: { token: string; data: Record<string, string>; android?: unknown } }
}

export interface FakePush {
  endpoint: string
  serviceAccountFile: string
  messages: FcmMessage[]
  unexpected: string[]
  tokenExchanges: () => number
  stop: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

function validAssertion(assertion: string, publicKey: string): boolean {
  const [header, claims, signature] = assertion.split('.')
  if (!header || !claims || !signature) return false
  const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`)
  return (
    decodeSegment(header).alg === 'RS256' &&
    decodeSegment(claims).scope === FCM_SCOPE &&
    verifier.verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url'))
  )
}

export async function startFakePush(): Promise<FakePush> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const messages: FcmMessage[] = []
  const unexpected: string[] = []
  let exchanges = 0
  const respond = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const http = createServer((req, res) => {
    void (async () => {
      const text = await readBody(req)
      if (req.method === 'POST' && req.url === '/token') {
        exchanges += 1
        const assertion = new URLSearchParams(text).get('assertion') ?? ''
        if (!validAssertion(assertion, publicPem)) return respond(res, 400, { error: 'invalid' })
        return respond(res, 200, {
          access_token: ACCESS_TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
        })
      }
      if (req.method === 'POST' && req.url === `/v1/projects/${PROJECT}/messages:send`) {
        messages.push({
          authorized: req.headers.authorization === `Bearer ${ACCESS_TOKEN}`,
          body: JSON.parse(text),
        })
        return respond(res, 200, { name: 'projects/ostia-e2e/messages/1' })
      }
      unexpected.push(`${req.method} ${req.url}`)
      return respond(res, 404, { error: 'not-found' })
    })()
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const dir = mkdtempSync(join(tmpdir(), 'ostia-fake-fcm-'))
  const serviceAccountFile = join(dir, 'service-account.json')
  writeFileSync(
    serviceAccountFile,
    JSON.stringify({
      client_email: `ostia@${PROJECT}.iam.gserviceaccount.com`,
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      project_id: PROJECT,
      token_uri: `${endpoint}/token`,
    }),
    { mode: 0o600 },
  )
  return {
    endpoint,
    serviceAccountFile,
    messages,
    unexpected,
    tokenExchanges: () => exchanges,
    stop: async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
