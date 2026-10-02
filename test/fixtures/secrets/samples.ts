const join = (...parts: string[]): string => parts.join('')
const fill = (seed: string, length: number): string =>
  seed.repeat(Math.ceil(length / seed.length)).slice(0, length)

export const FAKE = {
  awsAccessKeyId: join('AKIA', 'Q3EGUAAAA7BCDEFG'),
  awsSecretKey: join('wJalrXUtnFEMI/K7MDENG', '/bPxRfiCYzQ9Lm2pKEY'),
  githubClassic: join('ghp_', 'wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx'),
  githubFineGrained: join(
    'github_pat_',
    fill('11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789', 82),
  ),
  gitlab: join('glpat-', 'A1b2C3d4E5f6G7h8I9j0'),
  slackBot: join('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'),
  openaiLegacy: join(
    'sk-',
    fill('abcdefghijklmnopqrst', 20),
    'T3BlbkFJ',
    fill('ABCDEFGHIJKLMNOPQRST', 20),
  ),
  openaiProject: join(
    'sk-proj-',
    fill('aB3dE5gH7jK9mN1pQ', 58),
    'T3BlbkFJ',
    fill('zY8xW6vU4tS2rQ0pO', 58),
  ),
  anthropic: join('sk-ant-api03-', fill('aB3dE5gH7jK9mN1pQ_-', 93), 'AA'),
  stripeLive: join('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  stripeRestricted: join('rk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  googleApiKey: join('AIza', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe'),
  npm: join('npm_', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'),
  jwt: join(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ',
    '.',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ),
  privateKey: [
    join('-----BEGIN RSA ', 'PRIVATE KEY-----'),
    'MIIEpAIBAAKCAQEA04up8hoqzS1+APIB0RhjXyObwHQnOzhAk5Bd7mhkSbPkyhP1',
    'iGq7ybRXrXn0jc5cJ4ZxG2zB4tQ9mM8LbK8Y7Wr1q1Wd8u3n0d2tZ2v8H8a1M0Zk',
    join('-----END RSA ', 'PRIVATE KEY-----'),
  ].join('\n'),
  bearer: 'abcdef1234567890abcdef1234567890',
  basicAuthUrl: join('https://alice:', 's3cr3tPass', '@example.com'),
  postgresUrl: join('postgres://app:', 'hunter2pw', '@db.internal:5432/app'),
} as const

export const HARMLESS = {
  gitSha: '3f786850e387550fdab836ed7e6dc881de23001b',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  longPath:
    '/home/user/projects/acme/services/billing/src/handlers/invoices/createInvoiceHandler.ts',
  base64: fill(
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk',
    600,
  ),
  prose: 'Enter your password, then paste the token. The secret is never shown.',
} as const
