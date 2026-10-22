import { randomBytes } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  auth,
  createMCPClient,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { escape as escapeHtml } from 'es-toolkit'
import type {
  McpAuthState,
  McpServerSettings,
  McpSignInError,
  McpSignInResult,
} from '../../shared/assist/chatTools'
import { sameBytes } from '../platform/sameBytes'
import type { McpOAuthStore } from './mcpOAuthStore'

const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000
const MCP_OAUTH_CONNECT_TIMEOUT_MS = 15_000
export const MCP_OAUTH_BROWSER_ENV = 'MCP_OAUTH_BROWSER'
const MCP_OAUTH_CALLBACK_PATH = '/callback'
const DETAIL_MAX = 240

export type McpOAuthBrowser = 'system' | 'fetch'

export function mcpOAuthBrowser(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): McpOAuthBrowser {
  return !isPackaged && readEnv(MCP_OAUTH_BROWSER_ENV, env) === 'fetch' ? 'fetch' : 'system'
}

export class SignInFailure extends Error {
  constructor(
    readonly code: McpSignInError,
    readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX)
}

function respond(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(PRODUCT_DISPLAY_NAME)}</title><p>${escapeHtml(text)}</p>`,
  )
}

interface CallbackResult {
  code: string
  issuer?: string
}

export interface CallbackListener {
  redirectUrl: string
  result: Promise<CallbackResult>
  close: () => void
}

export async function openCallbackListener(opts: {
  state: string
  timeoutMs: number
  pages: { done: string; failed: string }
  redirectName?: string
}): Promise<CallbackListener> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const hosts = new Set([`127.0.0.1:${port}`, `${opts.redirectName ?? '127.0.0.1'}:${port}`])
  let settle: (outcome: CallbackResult | SignInFailure) => void = () => {}
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = (outcome) => (outcome instanceof SignInFailure ? reject(outcome) : resolve(outcome))
  })
  result.catch(() => undefined)
  const timer = setTimeout(() => settle(new SignInFailure('timeout')), opts.timeoutMs)
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (
      req.method !== 'GET' ||
      !hosts.has(req.headers.host ?? '') ||
      url.pathname !== MCP_OAUTH_CALLBACK_PATH
    ) {
      respond(res, 404, opts.pages.failed)
      return
    }
    const state = url.searchParams.get('state')
    if (state === null || !sameBytes(Buffer.from(state), Buffer.from(opts.state))) {
      respond(res, 400, opts.pages.failed)
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error || !code) {
      respond(res, 400, opts.pages.failed)
      const description = url.searchParams.get('error_description')
      settle(
        new SignInFailure(
          'failed',
          clip(error ? [error, description].filter(Boolean).join(': ') : 'no authorization code'),
        ),
      )
      return
    }
    respond(res, 200, opts.pages.done)
    settle({ code, issuer: url.searchParams.get('iss') ?? undefined })
  })
  return {
    redirectUrl: `http://${opts.redirectName ?? '127.0.0.1'}:${port}${MCP_OAUTH_CALLBACK_PATH}`,
    result,
    close: () => {
      clearTimeout(timer)
      settle(new SignInFailure('cancelled'))
      server.close()
      server.closeIdleConnections()
    },
  }
}

async function followWithFetch(url: URL): Promise<void> {
  const res = await fetch(url, { redirect: 'manual' })
  const location = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new SignInFailure('browser', `HTTP ${res.status}`)
  }
  await fetch(new URL(location, url), { redirect: 'manual' })
}

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: PRODUCT_DISPLAY_NAME,
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

function expiryOf(tokens: OAuthTokens, now: number): number | undefined {
  return typeof tokens.expires_in === 'number' ? now + tokens.expires_in * 1000 : undefined
}

export interface McpOAuthDeps {
  store: McpOAuthStore
  openExternal: (url: string) => boolean
  browser: McpOAuthBrowser
  pages: () => { done: string; failed: string }
  onChange: () => void
  now?: () => number
  timeoutMs?: number
  connectTimeoutMs?: number
}

interface Flow {
  url: string
  cancelled: boolean
  cancel: () => void
}

export class McpOAuth {
  private flows = new Map<string, Flow>()

  constructor(private readonly deps: McpOAuthDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  state(server: McpServerSettings, unauthorized: boolean): McpAuthState | undefined {
    if (!server.url) return undefined
    if (this.flows.has(server.name)) return 'signing-in'
    const record = this.deps.store.get(server.name, server.url)
    if (record?.tokens) {
      const lapsed =
        record.expiresAt !== undefined &&
        record.expiresAt <= this.now() &&
        !record.tokens.refresh_token
      return lapsed ? 'expired' : 'signed-in'
    }
    if (record) return 'expired'
    return unauthorized ? 'required' : undefined
  }

  provider(server: McpServerSettings): OAuthClientProvider | undefined {
    const { name, url } = server
    if (!url) return undefined
    const { store } = this.deps
    const record = store.get(name, url)
    if (!record?.tokens) return undefined
    const current = () => store.get(name, url)
    const lapse = (): void => {
      const now = current()
      if (!now?.tokens) return
      store.set(name, { url: now.url, redirectUrl: now.redirectUrl, client: now.client })
      this.deps.onChange()
    }
    return {
      tokens: () => current()?.tokens,
      saveTokens: (tokens) => {
        const now = current()
        if (!now) return
        store.set(name, { ...now, tokens, expiresAt: expiryOf(tokens, this.now()) })
        this.deps.onChange()
      },
      redirectToAuthorization: () => {
        if (!current()?.tokens?.refresh_token) lapse()
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => {
        throw new Error('no sign-in in progress')
      },
      invalidateCredentials: (scope) => {
        if (scope !== 'verifier') lapse()
      },
      get redirectUrl() {
        return record.redirectUrl
      },
      get clientMetadata() {
        return clientMetadata(record.redirectUrl)
      },
      clientInformation: () => current()?.client,
      saveAuthorizationServerInformation: () => {},
    }
  }

  async signIn(
    server: McpServerSettings | undefined,
    headers: Record<string, string>,
  ): Promise<McpSignInResult> {
    if (!server) return { ok: false, error: 'unknown-server' }
    const { name, url } = server
    if (!url) return { ok: false, error: 'not-http' }
    if (this.flows.has(name)) return { ok: false, error: 'in-progress' }
    if (!this.deps.store.canStore()) return { ok: false, error: 'encryption-unavailable' }
    const flow: Flow = { url, cancelled: false, cancel: () => {} }
    this.flows.set(name, flow)
    this.deps.onChange()
    let listener: CallbackListener | null = null
    try {
      const state = randomBytes(32).toString('base64url')
      listener = await openCallbackListener({
        state,
        timeoutMs: this.deps.timeoutMs ?? MCP_OAUTH_TIMEOUT_MS,
        pages: this.deps.pages(),
      })
      const opened = listener
      flow.cancel = () => {
        flow.cancelled = true
        opened.close()
      }
      const redirectUrl = opened.redirectUrl
      let client: OAuthClientInformation | undefined
      let tokens: OAuthTokens | undefined
      let verifier = ''
      let redirected = false
      const provider: OAuthClientProvider = {
        tokens: () => tokens,
        saveTokens: (next) => {
          tokens = next
        },
        redirectToAuthorization: async (authorizationUrl) => {
          if (flow.cancelled) throw new SignInFailure('cancelled')
          if (authorizationUrl.protocol !== 'https:' && authorizationUrl.protocol !== 'http:') {
            throw new SignInFailure('browser', clip(authorizationUrl.protocol))
          }
          if (this.deps.browser === 'fetch') await followWithFetch(authorizationUrl)
          else if (!this.deps.openExternal(authorizationUrl.href)) {
            throw new SignInFailure('browser')
          }
          redirected = true
        },
        saveCodeVerifier: (next) => {
          verifier = next
        },
        codeVerifier: () => verifier,
        state: () => state,
        storedState: () => state,
        get redirectUrl() {
          return redirectUrl
        },
        get clientMetadata() {
          return clientMetadata(redirectUrl)
        },
        clientInformation: () => client,
        isClientInformationDynamicallyRegistered: () => true,
        saveClientInformation: (next) => {
          client = next
        },
        invalidateCredentials: (scope) => {
          if (scope === 'all' || scope === 'client') client = undefined
          if (scope === 'all' || scope === 'tokens') tokens = undefined
        },
      }
      await this.challenge(url, headers, provider, () => redirected)
      const callback = await opened.result
      const result = await auth(provider, {
        serverUrl: url,
        authorizationCode: callback.code,
        callbackState: state,
        callbackIssuer: callback.issuer,
      })
      if (result !== 'AUTHORIZED' || !client || !tokens) throw new SignInFailure('failed')
      if (flow.cancelled) throw new SignInFailure('cancelled')
      const saved = this.deps.store.set(name, {
        url,
        redirectUrl,
        client,
        tokens,
        expiresAt: expiryOf(tokens, this.now()),
      })
      if (!saved.ok) throw new SignInFailure('failed', saved.error)
      return { ok: true }
    } catch (err) {
      if (flow.cancelled) return { ok: false, error: 'cancelled' }
      if (err instanceof SignInFailure) {
        return err.detail
          ? { ok: false, error: err.code, detail: err.detail }
          : { ok: false, error: err.code }
      }
      return {
        ok: false,
        error: 'failed',
        detail: clip(err instanceof Error ? err.message : String(err)),
      }
    } finally {
      listener?.close()
      this.flows.delete(name)
      this.deps.onChange()
    }
  }

  private async challenge(
    url: string,
    headers: Record<string, string>,
    provider: OAuthClientProvider,
    redirected: () => boolean,
  ): Promise<void> {
    let failure: unknown
    try {
      const client = await createMCPClient({
        transport: { type: 'http', url, headers, authProvider: provider },
        protocolVersionDiscovery: false,
        clientName: PRODUCT_DISPLAY_NAME,
        initializationOptions: {
          timeout: this.deps.connectTimeoutMs ?? MCP_OAUTH_CONNECT_TIMEOUT_MS,
        },
        onUncaughtError: (err) => {
          failure ??= err
        },
      })
      await client.close().catch(() => undefined)
    } catch (err) {
      if (redirected()) return
      throw failure instanceof SignInFailure ? failure : err
    }
    if (!redirected()) throw new SignInFailure('not-needed')
  }

  cancel(name: unknown): void {
    if (typeof name === 'string') this.flows.get(name)?.cancel()
  }

  signOut(name: string): void {
    this.flows.get(name)?.cancel()
    this.deps.store.clear(name)
    this.deps.onChange()
  }

  prune(servers: McpServerSettings[]): void {
    for (const [name, flow] of this.flows) {
      if (servers.find((s) => s.name === name)?.url !== flow.url) flow.cancel()
    }
    this.deps.store.prune(servers)
  }

  closeAll(): void {
    for (const flow of this.flows.values()) flow.cancel()
  }
}
