import { describe, expect, it } from 'vitest'
import { FAKE, HARMLESS } from '../../../test/fixtures/secrets/samples'
import { REDACTION_WORKER_SCRIPT, testScan } from '../../../test/redactionScan'
import type { ChatSession } from '../../shared/chatSessions'
import { REDACT_TEXTS_MAX, REDACT_TEXT_MAX } from '../../shared/redaction'
import { redactAssistRequest, redactChatSession } from '../../shared/redactionTargets'
import { createRedactor, createScrollbackRedactor, redactRequestedTexts } from './redaction'
import { createWorkerScan, redactionWorkerScript, scanDeadline } from './redactionScan'
import { libraryKinds } from './secretScanner'

const on = createRedactor(() => undefined, testScan)
const off = createRedactor(() => ({ redaction: { enabled: false } }), testScan)

const LIBRARY_CASES: [name: string, secret: string, kind: string][] = [
  ['an AWS access key id', FAKE.awsAccessKeyId, 'aws'],
  ['a classic GitHub token', FAKE.githubClassic, 'github'],
  ['a fine-grained GitHub token', FAKE.githubFineGrained, 'github'],
  ['a GitLab token', FAKE.gitlab, 'gitlab'],
  ['a Slack token', FAKE.slackBot, 'slack'],
  ['a legacy OpenAI key', FAKE.openaiLegacy, 'openai'],
  ['an OpenAI project key', FAKE.openaiProject, 'openai'],
  ['an Anthropic key', FAKE.anthropic, 'anthropic'],
  ['a Stripe live key', FAKE.stripeLive, 'stripe'],
  ['a Stripe restricted key', FAKE.stripeRestricted, 'stripe'],
  ['an npm token', FAKE.npm, 'npm'],
  ['a PEM private key', FAKE.privateKey, 'privatekey'],
  ['a URL with a password', FAKE.basicAuthUrl, 'basicauth'],
  ['a database URL with a password', FAKE.postgresUrl, 'database-connection-string'],
]

describe('createRedactor', () => {
  it.each(LIBRARY_CASES)('redacts %s', async (_name, secret, kind) => {
    const result = await on.redact(`before ${secret} after`)
    expect(result.text).toBe(`before [redacted:${kind}] after`)
    expect(result).toMatchObject({ count: 1, kinds: { [kind]: 1 } })
  })

  it('redacts the whole AWS secret key and keeps its name', async () => {
    const result = await on.redact(
      `aws_secret_access_key = ${FAKE.awsSecretKey}\nregion = us-east-1`,
    )
    expect(result.text).toBe('aws_secret_access_key = [redacted:aws]\nregion = us-east-1')
  })

  it('redacts the kinds the library lacks', async () => {
    const text = [
      `jwt ${FAKE.jwt}`,
      `google ${FAKE.googleApiKey}`,
      `Authorization: Bearer ${FAKE.bearer}`,
      'DB_PASSWORD=hunter2hunter2',
    ].join('\n')
    const result = await on.redact(text)
    expect(result.text).toBe(
      [
        'jwt [redacted:jwt]',
        'google [redacted:google-api-key]',
        'Authorization: Bearer [redacted:authorization]',
        'DB_PASSWORD=[redacted:assignment]',
      ].join('\n'),
    )
    expect(result.count).toBe(4)
  })

  it('names a token by its own kind when it is also the value of an assignment', async () => {
    expect((await on.redact(`GITHUB_TOKEN=${FAKE.githubClassic}`)).text).toBe(
      'GITHUB_TOKEN=[redacted:github]',
    )
  })

  it.each(Object.entries(HARMLESS))('leaves %s alone', async (_name, text) => {
    expect(await on.redact(`see ${text} here`)).toEqual({
      text: `see ${text} here`,
      count: 0,
      kinds: {},
    })
  })

  it('leaves ordinary shell output and code alone', async () => {
    const text = [
      'On branch main',
      `commit ${HARMLESS.gitSha} (HEAD -> main)`,
      'const password = await prompt("Password: ")',
      'export function verifyToken(token: string): boolean {',
      `-rw-r--r-- 1 u u 4096 Oct  1 12:00 ${HARMLESS.longPath}`,
    ].join('\n')
    expect((await on.redact(text)).text).toBe(text)
  })

  it('cannot be switched off by a comment in the text', async () => {
    const text = `/* secretlint-disable */\n${FAKE.githubClassic}\n/* secretlint-enable */`
    expect((await on.redact(text)).text).not.toContain(FAKE.githubClassic)
  })

  it('gives the same text when run on its own output', async () => {
    const text = [
      `GITHUB_TOKEN=${FAKE.githubClassic}`,
      `password="${FAKE.bearer}"`,
      FAKE.basicAuthUrl,
      FAKE.privateKey,
      `aws_secret_access_key = ${FAKE.awsSecretKey}`,
    ].join('\n')
    const once = await on.redact(text)
    expect(once.count).toBe(5)
    expect(await on.redact(once.text)).toEqual({ text: once.text, count: 0, kinds: {} })
  })

  it('changes nothing while the setting is off, and preview still shows what it would do', async () => {
    const text = `token ${FAKE.githubClassic}`
    expect(await off.redact(text)).toEqual({ text, count: 0, kinds: {} })
    expect((await off.preview(text)).text).toBe('token [redacted:github]')
  })

  it("applies the human's patterns and ignores an invalid one", async () => {
    const custom = createRedactor(
      () => ({
        redaction: { patterns: ['ACME-[0-9]{6}', '(a+)+b', 'ACME-['] },
      }),
      testScan,
    )
    const result = await custom.redact('ticket ACME-123456 aaaaab')
    expect(result.text).toBe('ticket [redacted:custom] aaaaab')
    expect(result.kinds).toEqual({ custom: 1 })
  })

  it('reads the settings again on every call', async () => {
    let privacy: unknown = { redaction: { enabled: false } }
    const live = createRedactor(() => privacy, testScan)
    const text = `x ${FAKE.npm}`
    expect((await live.redact(text)).count).toBe(0)
    privacy = { redaction: { enabled: true } }
    expect((await live.redact(text)).count).toBe(1)
  })

  it('lists the library rules as kinds, without the comment filter, then its own', () => {
    const kinds = on.kinds()
    const library = kinds.filter((k) => k.source === 'library').map((k) => k.kind)
    expect(library).toEqual(libraryKinds().map((k) => k.kind))
    expect(library).toEqual(expect.arrayContaining(['aws', 'github', 'privatekey', 'basicauth']))
    expect(library).not.toContain('filter-comments')
    expect(kinds.find((k) => k.kind === 'aws')?.detects).toContain('AWSSecretAccessKey')
    expect(kinds.filter((k) => k.source === 'ostia').map((k) => k.kind)).toEqual([
      'jwt',
      'google-api-key',
      'authorization',
      'assignment',
    ])
  })

  it('fails instead of passing text through when the scan fails', async () => {
    const broken = createRedactor(
      () => undefined,
      async () => {
        throw new Error('scan failed')
      },
    )
    await expect(broken.redact('anything')).rejects.toThrow('scan failed')
  })
})

describe('redactionWorkerScript', () => {
  it('points into app.asar.unpacked for a packaged app', () => {
    expect(redactionWorkerScript('/opt/ostia/resources/app.asar')).toBe(
      '/opt/ostia/resources/app.asar.unpacked/out/redaction/worker.js',
    )
  })

  it('stays in the project folder when unpackaged', () => {
    expect(redactionWorkerScript('/home/u/ostia')).toBe('/home/u/ostia/out/redaction/worker.js')
  })
})

describe('the redaction worker', () => {
  const STALLING = ['[a-z]+Z']
  const HUGE = 'a'.repeat(8 * 1024 * 1024)

  it('fails closed within its deadline when a pattern of the human never finishes', async () => {
    const worker = createWorkerScan(REDACTION_WORKER_SCRIPT, () => 400)
    const redactor = createRedactor(() => ({ redaction: { patterns: STALLING } }), worker.scan)
    const started = performance.now()
    await expect(redactor.redact(HUGE)).rejects.toThrow('scan timed out')
    expect(performance.now() - started).toBeLessThan(3000)
    await worker.close()
  })

  it('serves the next scan with a fresh worker after one timed out', async () => {
    const worker = createWorkerScan(REDACTION_WORKER_SCRIPT, (length) =>
      length > 1000 ? 300 : 5000,
    )
    await expect(worker.scan(HUGE, STALLING)).rejects.toThrow('scan timed out')
    expect(await worker.scan(`k ${FAKE.npm}`, [])).toEqual([
      expect.objectContaining({ kind: 'npm' }),
    ])
    await worker.close()
  })

  it('keeps the main event loop responsive while a slow scan runs', async () => {
    const worker = createWorkerScan(REDACTION_WORKER_SCRIPT, () => 1500)
    const gaps: number[] = []
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }, 20)
    const scan = worker.scan(HUGE, STALLING)
    await expect(scan).rejects.toThrow('scan timed out')
    clearInterval(tick)
    await worker.close()
    expect(gaps.length).toBeGreaterThan(20)
    expect(Math.max(...gaps)).toBeLessThan(250)
  })

  it('answers queued scans in order', async () => {
    const worker = createWorkerScan(REDACTION_WORKER_SCRIPT)
    const redactor = createRedactor(() => undefined, worker.scan)
    const results = await Promise.all(['a', `x ${FAKE.npm}`, 'b'].map((t) => redactor.redact(t)))
    expect(results.map((r) => r.count)).toEqual([0, 1, 0])
    await worker.close()
  })
})

describe('redaction speed', () => {
  const MIB = 1024 * 1024
  const BUDGET_MS = process.platform === 'darwin' ? 30_000 : 5000
  const fill = (unit: string): string => unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB)
  const ADVERSARIAL: [name: string, text: string][] = [
    ['one letter', fill('a')],
    ['JWT prefixes', fill('eyJ')],
    ['JWT parts with no end', fill('eyJhbGciOiJIUzI1NiJ9.')],
    ['key prefixes', fill('sk-')],
    ['token prefixes', fill('ghp_')],
    ['AWS prefixes', fill('AKIA')],
    ['private key headers', fill('-----BEGIN RSA PRIVATE KEY-----\n')],
    ['URL user parts', fill('https://a:')],
    ['assignment names', fill('password=')],
    ['secret names', fill('passwordtokensecret')],
    ['authorization headers', fill('Authorization: Bearer ')],
    ['quotes after a name', fill('token: "')],
    ['blank lines', fill('\n')],
    ['spaces', fill(' ')],
  ]

  it.each(ADVERSARIAL)('reads 1 MiB of %s without stalling', async (_name, text) => {
    const custom = createRedactor(
      () => ({ redaction: { patterns: ['ACME-[A-Za-z0-9]{32}'] } }),
      testScan,
    )
    const started = performance.now()
    await custom.redact(text)
    expect(performance.now() - started).toBeLessThan(BUDGET_MS)
  })

  it('settles within its deadline on 1 MiB made to stall an open-ended pattern, never blocking main', async () => {
    const worker = createWorkerScan(REDACTION_WORKER_SCRIPT)
    const custom = createRedactor(
      () => ({ redaction: { patterns: ['[a-z]+Z', 'x[0-9]{1,64}y'] } }),
      worker.scan,
    )
    const gaps: number[] = []
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
    }, 20)
    const outcomes: string[] = []
    const started = performance.now()
    for (const text of [fill('a'), fill('x1')]) {
      try {
        const result = await custom.redact(text)
        expect(result.count).toBe(0)
        outcomes.push('spans')
      } catch (error) {
        expect((error as Error).message).toBe('scan timed out')
        outcomes.push('timed out')
      }
    }
    const elapsed = performance.now() - started
    clearInterval(tick)
    await worker.close()
    expect(elapsed).toBeLessThan(2 * scanDeadline(MIB) + 4000)
    expect(Math.max(...gaps)).toBeLessThan(500)
    if (process.platform !== 'darwin') expect(outcomes).toEqual(['spans', 'spans'])
  }, 60_000)

  it('reads 1 MiB of mixed terminal output with secrets without stalling', async () => {
    const block = [
      `export GITHUB_TOKEN=${FAKE.githubClassic}`,
      `commit ${HARMLESS.gitSha}`,
      FAKE.privateKey,
      HARMLESS.longPath,
      `curl -H "Authorization: Bearer ${FAKE.bearer}" ${FAKE.basicAuthUrl}/v1`,
    ].join('\n')
    const started = performance.now()
    const result = await on.redact(fill(`${block}\n`))
    expect(performance.now() - started).toBeLessThan(BUDGET_MS)
    expect(result.text).not.toContain(FAKE.githubClassic)
    expect(result.count).toBeGreaterThan(1000)
  })
})

describe('redactRequestedTexts', () => {
  it('redacts each text of a renderer request', async () => {
    const results = await redactRequestedTexts(on, ['plain', `k ${FAKE.npm}`])
    expect(results?.map((r) => r.text)).toEqual(['plain', 'k [redacted:npm]'])
  })

  it('refuses a request that is not a bounded list of strings', () => {
    expect(redactRequestedTexts(on, 'text')).toBeNull()
    expect(redactRequestedTexts(on, [1])).toBeNull()
    expect(redactRequestedTexts(on, new Array(REDACT_TEXTS_MAX + 1).fill('a'))).toBeNull()
    expect(redactRequestedTexts(on, ['a'.repeat(REDACT_TEXT_MAX + 1)])).toBeNull()
  })
})

describe('redactAssistRequest', () => {
  const secret = FAKE.githubClassic
  const mark = '[redacted:github]'

  it('redacts the text and tool results of a chat request and its context', async () => {
    const { request, count } = await redactAssistRequest(
      'chat',
      {
        messages: [
          { role: 'user', content: `why does ${secret} fail` },
          {
            role: 'assistant',
            content: 'reading',
            tools: [
              {
                id: 'c1',
                name: 'read_file',
                input: { path: '.env' },
                state: 'done',
                output: secret,
              },
              { id: 'c2', name: 'read_file', input: {}, state: 'error', error: `bad ${secret}` },
            ],
          },
        ],
        context: [{ kind: 'output', label: 'Output', text: `$ echo ${secret}` }],
      },
      on.redact,
    )
    expect(JSON.stringify(request)).not.toContain(secret)
    expect(request.messages[0].content).toBe(`why does ${mark} fail`)
    expect(request.messages[1].tools?.[0]).toMatchObject({ output: mark, input: { path: '.env' } })
    expect(request.messages[1].tools?.[1].error).toBe(`bad ${mark}`)
    expect(request.context[0].text).toBe(`$ echo ${mark}`)
    expect(count).toBe(4)
  })

  it('redacts the draft, history and context of a terminal request', async () => {
    const { request, count } = await redactAssistRequest(
      'terminal',
      {
        line: `curl -H "x: ${secret}"`,
        cwd: '/home/u/proj',
        history: [{ command: `export T=${secret}`, exitCode: 0 }],
        context: [{ label: 'git', text: secret }],
      },
      on.redact,
    )
    expect(request).toEqual({
      line: `curl -H "x: ${mark}"`,
      cwd: '/home/u/proj',
      history: [{ command: `export T=${mark}`, exitCode: 0 }],
      context: [{ label: 'git', text: mark }],
    })
    expect(count).toBe(3)
  })

  it('redacts the code around the cursor of a completion request', async () => {
    const { request } = await redactAssistRequest(
      'completion',
      {
        path: '/p/a.ts',
        language: 'typescript',
        prefix: `const key = '${secret}'\n`,
        suffix: `// ${secret}`,
        neighbors: [{ path: '/p/b.ts', text: secret }],
      },
      on.redact,
    )
    expect(JSON.stringify(request)).not.toContain(secret)
    expect(request.path).toBe('/p/a.ts')
  })

  it('redacts a prompt draft and a command query', async () => {
    const input = await redactAssistRequest('input', { text: secret, tasks: ['typos'] }, on.redact)
    expect(input.request).toEqual({ text: mark, tasks: ['typos'] })
    const command = await redactAssistRequest('command', { query: `use ${secret}` }, on.redact)
    expect(command).toEqual({ request: { query: `use ${mark}` }, count: 1 })
  })

  it('returns the request as it was while the setting is off', async () => {
    const original = {
      messages: [{ role: 'user' as const, content: `why does ${secret} fail` }],
      context: [{ kind: 'output' as const, label: 'Output', text: secret }],
    }
    expect(await redactAssistRequest('chat', original, off.redact)).toEqual({
      request: original,
      count: 0,
    })
  })
})

describe('redactChatSession', () => {
  const secret = FAKE.stripeLive
  const session: ChatSession = {
    id: 's1',
    title: `About ${secret}`,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: `my key is ${secret}` }],
        metadata: { context: [{ kind: 'file', label: '.env', text: `STRIPE=${secret}` }] },
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Looking.' },
          {
            type: 'dynamic-tool',
            toolName: 'read_file',
            toolCallId: 'c1',
            state: 'output-available',
            input: { path: '.env' },
            output: { path: '.env', content: `STRIPE=${secret}`, lines: 1 },
          },
        ],
      },
    ],
  }

  it('redacts what the human sent and what tools returned, and keeps the shape', async () => {
    const saved = await redactChatSession(session, on.text)
    expect(JSON.stringify(saved)).not.toContain(secret)
    expect(saved.messages[0].parts[0].text).toBe('my key is [redacted:stripe]')
    expect(saved.messages[0].metadata?.context?.[0].text).toBe('STRIPE=[redacted:stripe]')
    expect(saved.messages[1].parts[1]).toMatchObject({
      input: { path: '.env' },
      output: { path: '.env', content: 'STRIPE=[redacted:stripe]', lines: 1 },
    })
    expect(saved.messages[1].parts[0].text).toBe('Looking.')
  })

  it('saves the session as it is while the setting is off', async () => {
    expect(await redactChatSession(session, off.text)).toEqual(session)
  })
})

describe('createScrollbackRedactor', () => {
  const screen = `\x1b[32m$\x1b[0m export NPM_TOKEN=${FAKE.npm}\r\n\x1b[1mdone\x1b[0m\r\n`

  it('redacts the serialized screen and keeps its colors', async () => {
    const redact = createScrollbackRedactor(on)
    expect(await redact({ p1: screen, p2: 'plain\r\n' })).toEqual({
      p1: '\x1b[32m$\x1b[0m export NPM_TOKEN=[redacted:npm]\r\n\x1b[1mdone\x1b[0m\r\n',
      p2: 'plain\r\n',
    })
  })

  it('returns the screens unchanged while the setting is off', async () => {
    expect(await createScrollbackRedactor(off)({ p1: screen })).toEqual({ p1: screen })
  })

  it('scans a pane again only when its screen or the settings changed', async () => {
    let privacy: unknown = undefined
    const scans: string[] = []
    const counting = createRedactor(
      () => privacy,
      async (text) => {
        scans.push(text)
        return []
      },
    )
    const redact = createScrollbackRedactor(counting)
    await redact({ p1: 'one', p2: 'two' })
    await redact({ p1: 'one', p2: 'two changed' })
    expect(scans).toEqual(['one', 'two', 'two changed'])
    privacy = { redaction: { patterns: ['ACME-[0-9]{4}'] } }
    await redact({ p1: 'one' })
    expect(scans).toHaveLength(4)
  })
})
