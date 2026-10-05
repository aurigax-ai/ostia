import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, BrowserWindow: {}, dialog: {} }))

const { createChatSessionStore } = await import('./chatSessions')
const { saveRedacted } = await import('./chatSessionsIpc')
const { createRedactor } = await import('./redaction')
const { testScan } = await import('../../test/redactionScan')

const secret = FAKE.anthropic

function session(): unknown {
  return {
    id: 'chat-1',
    title: 'Keys',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: `is ${secret} valid` }],
        metadata: { context: [{ kind: 'output', label: 'Output', text: `KEY=${secret}` }] },
      },
    ],
  }
}

describe('saveRedacted', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-chat-redact-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the session file without the secret', async () => {
    const store = createChatSessionStore({ dir })
    const res = await saveRedacted(store, session(), createRedactor(() => undefined, testScan).text)
    expect(res.ok).toBe(true)
    const file = readFileSync(join(dir, 'chat-1.json'), 'utf8')
    expect(file).not.toContain(secret)
    expect(file).toContain('is [redacted:anthropic] valid')
    expect(store.get('chat-1')?.messages[0].metadata?.context?.[0].text).toBe(
      'KEY=[redacted:anthropic]',
    )
  })

  it('writes the session as it is while the setting is off', async () => {
    const store = createChatSessionStore({ dir })
    const off = createRedactor(() => ({ redaction: { enabled: false } }), testScan)
    await saveRedacted(store, session(), off.text)
    expect(readFileSync(join(dir, 'chat-1.json'), 'utf8')).toContain(`is ${secret} valid`)
  })

  it('writes nothing when redaction fails', async () => {
    const store = createChatSessionStore({ dir })
    const res = await saveRedacted(store, session(), async () => {
      throw new Error('scan failed')
    })
    expect(res).toEqual({ ok: false, error: 'redaction-failed' })
    expect(store.get('chat-1')).toBeNull()
  })

  it('still refuses an invalid session', async () => {
    const store = createChatSessionStore({ dir })
    expect(await saveRedacted(store, { id: 'x' }, async (t) => t)).toEqual({
      ok: false,
      error: 'invalid-session',
    })
  })
})
