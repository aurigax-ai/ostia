import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { FAKE, HARMLESS } from '../../../test/fixtures/secrets/samples'
import { createAgentJournal } from './agentJournal'
import { createAppLog, formatEntry } from './appLog'

function journal() {
  const info = vi.fn()
  const warn = vi.fn()
  return { journal: createAgentJournal({ info, warn }), info, warn }
}

describe('agent journal calls', () => {
  it('records an ok call as an info line with its size and time', () => {
    const { journal: j, info, warn } = journal()
    j.call({ method: 'pane.status', caller: 'pane', ms: 12.4, bytes: 480 })
    expect(info).toHaveBeenCalledWith('call', {
      method: 'pane.status',
      caller: 'pane',
      outcome: 'ok',
      ms: 12,
      bytes: 480,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('records an error with its code only, and a read-back mismatch as its own outcome', () => {
    const { journal: j, warn } = journal()
    j.call({ method: 'pane.read', caller: 'script', ms: 1, bytes: 0, code: 'unknown-pane: p-77' })
    j.call({ method: 'pane.input', caller: 'pane', ms: 1, bytes: 0, code: 'not-submitted: p-77 …' })
    expect(warn.mock.calls.map(([, fields]) => [fields.outcome, fields.code])).toEqual([
      ['error', 'unknown-pane'],
      ['readback-mismatch', 'not-submitted'],
    ])
  })

  it('flags an answer over its verb budget, on a warn line', () => {
    const { journal: j, warn } = journal()
    j.call({ method: 'pane.list', caller: 'extension', ms: 1, bytes: 90_000 })
    expect(warn).toHaveBeenCalledWith(
      'over-budget',
      expect.objectContaining({ over: 'bytes', outcome: 'ok' }),
    )
  })

  it('names a method it does not know as other, so a caller cannot write its own text', () => {
    const { journal: j, info } = journal()
    j.call({ method: `x ${FAKE.openaiLegacy}`, caller: 'pane', ms: 1, bytes: 1 })
    expect(info.mock.calls[0][1].method).toBe('other')
  })

  it('records a failed mail by its reason and age, a lease timeout and a wake that was not ready', () => {
    const { journal: j, warn } = journal()
    j.mail('expired:hibernated', 86_400_000.4)
    j.leaseTimeout(120_000)
    j.wakeNotReady(121_000)
    expect(warn.mock.calls).toEqual([
      ['mail-failed', { code: 'expired:hibernated', age: 86_400_000 }],
      ['mail-lease', { code: 'lease-timeout', age: 120_000 }],
      ['wake', { code: 'wake-not-ready', ms: 121_000 }],
    ])
  })
})

describe('agent journal file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-agent-journal-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a 0600 file that holds no parameter, text, id or secret, whatever the caller sent', async () => {
    const file = join(dir, 'journal.log')
    const j = createAgentJournal(createAppLog(file, { maxBytes: 4096, keep: 2 }))
    const secrets = [...Object.values(FAKE), HARMLESS.uuid, HARMLESS.longPath, HARMLESS.prose]
    for (const secret of secrets) {
      j.call({ method: 'bus.send', caller: 'pane', ms: 5, bytes: 100, code: `denied: ${secret}` })
      j.call({ method: secret, caller: 'script', ms: 5, bytes: 100, code: secret })
    }
    await vi.waitFor(() => expect(statSync(file).size).toBeGreaterThan(0))
    const text = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n')
    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).toContain('method=bus.send')
    expect(text).toContain('code=denied')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rotates by size and keeps every file 0600', async () => {
    const file = join(dir, 'rotating.log')
    const j = createAgentJournal(createAppLog(file, { maxBytes: 1024, keep: 2 }))
    for (let i = 0; i < 60; i++) j.call({ method: 'pane.read', caller: 'pane', ms: i, bytes: 1000 })
    await vi.waitFor(() =>
      expect(readdirSync(dir).filter((n) => n.startsWith('rotating')).length).toBe(2),
    )
    for (const name of readdirSync(dir).filter((n) => n.startsWith('rotating'))) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    }
  })

  it('shows what one line looks like', () => {
    expect(
      formatEntry('call', { method: 'pane.read', caller: 'pane', outcome: 'ok', ms: 3, bytes: 20 }),
    ).toBe('call method=pane.read caller=pane outcome=ok ms=3 bytes=20')
  })
})

describe('agent journal and the incident timeline', () => {
  it('hands the pane to the timeline and keeps it out of the log line', () => {
    const info = vi.fn()
    const warn = vi.fn()
    const mail = vi.fn()
    const wake = vi.fn()
    const hook = vi.fn()
    const j = createAgentJournal({ info, warn }, { mail, wake, hook })
    j.mail('agent-refused: it said no', 1500, 'pane-ext-1')
    j.wakeNotReady(90_000, ['pane-ext-1', 'pane-ext-2'])
    expect(mail).toHaveBeenCalledWith('pane-ext-1', 'agent-refused', 1500)
    expect(wake).toHaveBeenCalledTimes(2)
    j.hook('pane-ext-1', 'prompt-submit')
    expect(hook).toHaveBeenCalledWith('pane-ext-1', true, 'prompt-submit')
    expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain('pane-ext')
  })
})
