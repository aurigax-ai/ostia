import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { readSessionInfo, TRANSCRIPT_TAIL_BYTES } = await import('./agentTranscript')

function home(): string {
  return mkdtempSync(join(tmpdir(), 'pine-transcript-'))
}

describe('readSessionInfo', () => {
  it('finds a Claude transcript by session id in any project folder', () => {
    const h = home()
    mkdirSync(join(h, '.claude', 'projects', '-w'), { recursive: true })
    writeFileSync(
      join(h, '.claude', 'projects', '-w', 'abc-1.jsonl'),
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Hello' })}\n`,
    )
    expect(readSessionInfo({ agent: 'claude', id: 'abc-1' }, h)?.title).toBe('Hello')
    expect(readSessionInfo({ agent: 'claude', id: 'missing' }, h)).toBeNull()
  })

  it('ignores a symlinked transcript', () => {
    const h = home()
    const dir = join(h, '.claude', 'projects', '-w')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(h, 'elsewhere.jsonl'),
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'x' })}\n`,
    )
    symlinkSync(join(h, 'elsewhere.jsonl'), join(dir, 'abc-1.jsonl'))
    expect(readSessionInfo({ agent: 'claude', id: 'abc-1' }, h)).toBeNull()
  })

  it('reads a long Codex rollout: the session header from the start, usage from the end', () => {
    const h = home()
    const dir = join(h, '.codex', 'sessions', '2026', '09', '30')
    mkdirSync(dir, { recursive: true })
    const filler = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'x'.repeat(1000) } })}\n`
    writeFileSync(
      join(dir, 'rollout-2026-09-30T06-56-33-01a0f1f5.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/w', git: { branch: 'dev' } } })}\n${filler.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 10)}${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4' } })}\n`,
    )
    const info = readSessionInfo({ agent: 'codex', id: '01a0f1f5' }, h)
    expect(info).toMatchObject({ branch: 'dev', cwd: '/w', model: 'gpt-5.4' })
  })
})
