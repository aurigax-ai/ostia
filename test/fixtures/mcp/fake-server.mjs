import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'env',
    description: 'Read one environment variable of the server',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'slow',
    description: 'Answers after a delay',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  {
    name: 'exit',
    description: 'Stops the server',
    inputSchema: { type: 'object', properties: {} },
  },
]

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], isError }
}

async function call(name, args) {
  if (name === 'echo') return text(`echo: ${args.text ?? ''}`)
  if (name === 'env') return text(process.env[args.name] ?? '(unset)')
  if (name === 'fail') return text('boom', true)
  if (name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 1000)))
    return text('slow done')
  }
  if (name === 'exit') process.exit(1)
  return null
}

async function answer(message) {
  if (message.id === undefined) return null
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    const result = await call(params.name, params.arguments ?? {})
    if (result) return { jsonrpc: '2.0', id, result }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params.name}` } }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } }
}

function serveStdio() {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    void answer(JSON.parse(line)).then((response) => {
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    })
  })
  lines.on('close', () => process.exit(0))
}

function option(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function token() {
  return randomBytes(24).toString('base64url')
}

function serveHttp() {
  const oauth = process.argv.includes('--oauth')
  const ttl = Number(option('--token-ttl') ?? 3600)
  const clients = new Map()
  const codes = new Map()
  const accessTokens = new Set()
  const refreshTokens = new Map()
  const stats = { registrations: 0, authorizations: 0, exchanges: 0, refreshes: 0, calls: 0 }
  let deny = false
  let origin = ''

  const issue = (clientId) => {
    const access = token()
    const refresh = token()
    accessTokens.add(access)
    refreshTokens.set(refresh, clientId)
    return { access_token: access, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh }
  }

  const authorized = (req) => {
    const header = req.headers.authorization ?? ''
    return header.startsWith('Bearer ') && accessTokens.has(header.slice(7))
  }

  const mcp = async (req, res) => {
    if (req.method === 'DELETE') return json(res, 200, {})
    if (req.method !== 'POST') return json(res, 405, {})
    if (oauth && !authorized(req)) {
      return json(
        res,
        401,
        { error: 'unauthorized' },
        {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      )
    }
    stats.calls += 1
    const response = await answer(JSON.parse(await readBody(req)))
    if (!response) {
      res.writeHead(202)
      res.end()
      return
    }
    json(res, 200, response)
  }

  const register = async (req, res) => {
    const body = JSON.parse(await readBody(req))
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return json(res, 400, { error: 'invalid_redirect_uri' })
    }
    const clientId = `client-${token()}`
    clients.set(clientId, body.redirect_uris)
    stats.registrations += 1
    json(res, 201, { ...body, client_id: clientId, client_id_issued_at: 1 })
  }

  const authorize = (url, res) => {
    const query = url.searchParams
    const clientId = query.get('client_id')
    const redirectUri = query.get('redirect_uri')
    if (!clients.get(clientId)?.includes(redirectUri)) return json(res, 400, { error: 'client' })
    if (
      query.get('response_type') !== 'code' ||
      query.get('code_challenge_method') !== 'S256' ||
      !query.get('code_challenge') ||
      !query.get('state')
    ) {
      return json(res, 400, { error: 'invalid_request' })
    }
    stats.authorizations += 1
    const target = new URL(redirectUri)
    target.searchParams.set('state', query.get('state'))
    target.searchParams.set('iss', origin)
    if (deny) {
      target.searchParams.set('error', 'access_denied')
      target.searchParams.set('error_description', 'The fake human said no')
    } else {
      const code = token()
      codes.set(code, { clientId, redirectUri, challenge: query.get('code_challenge') })
      target.searchParams.set('code', code)
    }
    res.writeHead(302, { location: target.href })
    res.end()
  }

  const exchange = async (req, res) => {
    const form = new URLSearchParams(await readBody(req))
    const clientId = form.get('client_id')
    if (form.get('grant_type') === 'authorization_code') {
      const pending = codes.get(form.get('code'))
      codes.delete(form.get('code'))
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
      if (
        !pending ||
        pending.clientId !== clientId ||
        pending.redirectUri !== form.get('redirect_uri') ||
        pending.challenge !== challenge
      ) {
        return json(res, 400, { error: 'invalid_grant' })
      }
      stats.exchanges += 1
      return json(res, 200, issue(clientId))
    }
    if (form.get('grant_type') === 'refresh_token') {
      const refresh = form.get('refresh_token')
      if (refreshTokens.get(refresh) !== clientId) return json(res, 400, { error: 'invalid_grant' })
      refreshTokens.delete(refresh)
      stats.refreshes += 1
      return json(res, 200, issue(clientId))
    }
    json(res, 400, { error: 'unsupported_grant_type' })
  }

  const control = async (req, res) => {
    if (req.method === 'POST') {
      const { action } = JSON.parse(await readBody(req))
      if (action === 'expire' || action === 'revoke') accessTokens.clear()
      if (action === 'revoke') refreshTokens.clear()
      if (action === 'deny') deny = true
    }
    json(res, 200, stats)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const route = async () => {
      if (url.pathname === '/mcp') return mcp(req, res)
      if (url.pathname === '/control') return control(req, res)
      if (!oauth) return json(res, 404, {})
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] })
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (url.pathname === '/register' && req.method === 'POST') return register(req, res)
      if (url.pathname === '/authorize' && req.method === 'GET') return authorize(url, res)
      if (url.pathname === '/token' && req.method === 'POST') return exchange(req, res)
      json(res, 404, {})
    }
    route().catch(() => json(res, 500, {}))
  })
  server.listen(Number(option('--port') ?? 0), '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`
    process.stdout.write(`${JSON.stringify({ url: `${origin}/mcp` })}\n`)
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}

if (process.argv.includes('--http')) serveHttp()
else serveStdio()
