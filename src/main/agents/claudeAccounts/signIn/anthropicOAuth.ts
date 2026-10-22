import { createHash, randomBytes } from 'node:crypto'

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
const DEFAULT_LIFETIME_S = 3600

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

export function validCode(input: string): string | null {
  const code = input.trim()
  return CODE_SHAPE.test(code) ? code : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  const accessToken = text(body?.access_token)
  const refreshToken = text(body?.refresh_token)
  if (!accessToken || !refreshToken) return null
  const seconds = Number(body?.expires_in)
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_LIFETIME_S
  return {
    accessToken,
    refreshToken,
    expiresAt: now + lifetime * 1000,
    scopes: (text(body?.scope) ?? SCOPES.join(' ')).split(' '),
  }
}

export async function fetchProfile(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<OAuthProfile | null> {
  const res = await request(PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as {
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
