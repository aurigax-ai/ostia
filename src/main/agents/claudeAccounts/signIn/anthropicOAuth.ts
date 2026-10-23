import { createHash, randomBytes } from 'node:crypto'
import { sameBytes } from '../../../platform/sameBytes'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const REQUEST_TIMEOUT_MS = 30_000
const CODE_SHAPE = /^[A-Za-z0-9_-]{16,512}$/
const BODY_MAX = 64 * 1024
const TOKEN_MAX = 4096
const FIELD_MAX = 512
const LIFETIME_MIN_S = 60
const LIFETIME_MAX_S = 365 * 24 * 3600
const TOKEN_SHAPE = /^[\x21-\x7e]+$/
const CALLBACK_PATH = '/callback'
const LOOPBACK = new Set(['localhost', '127.0.0.1'])

export interface Pkce {
  verifier: string
  challenge: string
  state: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

export interface OAuthProfile {
  accountUuid: string
  emailAddress: string
  displayName: string | null
  organizationUuid: string | null
  organizationName: string | null
  subscriptionType: string | null
  rateLimitTier: string | null
}

const SUBSCRIPTIONS: Record<string, string> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_team: 'team',
  claude_enterprise: 'enterprise',
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url'),
  }
}

export function authorizeUrl(redirectUri: string, pkce: Pkce): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', pkce.state)
  return url.toString()
}

function sameState(given: string, expected: string): boolean {
  return sameBytes(Buffer.from(given), Buffer.from(expected))
}

function codeFromUrl(input: string): { code: string; state: string | null } | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.pathname !== CALLBACK_PATH) {
    return null
  }
  const code = url.searchParams.get('code')
  return code ? { code, state: url.searchParams.get('state') } : null
}

export function parseCode(input: string, expectedState: string): string | null {
  const trimmed = input.trim()
  const fromUrl = codeFromUrl(trimmed)
  const [code, state] = fromUrl
    ? [fromUrl.code, fromUrl.state]
    : (trimmed.split('#', 2) as [string, string | undefined])
  if (!CODE_SHAPE.test(code)) return null
  if (state !== undefined && state !== null && !sameState(state, expectedState)) return null
  return code
}

function text(value: unknown, max = FIELD_MAX): string | null {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : null
}

function token(value: unknown): string | null {
  const found = text(value, TOKEN_MAX)
  return found && TOKEN_SHAPE.test(found) ? found : null
}

export async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done || !value) break
    size += value.length
    if (size > BODY_MAX) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function grantedScopes(value: unknown): string[] | null {
  if (value === undefined) return SCOPES
  const given = typeof value === 'string' ? value.split(' ').filter(Boolean) : null
  return given && given.length > 0 && given.every((scope) => SCOPES.includes(scope)) ? given : null
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  pkce: Pkce,
  now: number,
  request: typeof fetch = fetch,
): Promise<OAuthTokens | null> {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state: pkce.state,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = await readJson(res)
  const accessToken = token(body?.access_token)
  const refreshToken = token(body?.refresh_token)
  const seconds = body?.expires_in
  const scopes = grantedScopes(body?.scope)
  if (!accessToken || !refreshToken || !scopes) return null
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  const lifetime = Math.min(Math.max(seconds, LIFETIME_MIN_S), LIFETIME_MAX_S)
  return { accessToken, refreshToken, expiresAt: now + lifetime * 1000, scopes }
}

export async function fetchProfile(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<OAuthProfile | null> {
  const res = await request(PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = (await readJson(res)) as {
    account?: Record<string, unknown>
    organization?: Record<string, unknown>
  } | null
  const accountUuid = text(body?.account?.uuid)
  const emailAddress = text(body?.account?.email)
  if (!accountUuid || !emailAddress) return null
  const type = text(body?.organization?.organization_type)
  return {
    accountUuid,
    emailAddress,
    displayName: text(body?.account?.display_name),
    organizationUuid: text(body?.organization?.uuid),
    organizationName: text(body?.organization?.name),
    subscriptionType: type ? (SUBSCRIPTIONS[type] ?? null) : null,
    rateLimitTier: text(body?.organization?.rate_limit_tier),
  }
}
