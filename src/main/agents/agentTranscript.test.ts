import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { codexSessionFolder, readSessionInfo, TRANSCRIPT_TAIL_BYTES } = await import(
  './agentTranscript'
)
const { readRange, readTail } = await import('./transcriptFiles')

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ostia-transcript-'))
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

describe('codexSessionFolder', () => {
  function rollout(h: string, lines: unknown[]): void {
    const dir = join(h, '.codex', 'sessions', '2026', '10', '28')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'rollout-2026-10-28T01-21-22-01a180f4.jsonl'),
      `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    )
  }

  it('names the latest folder the session recorded after a /cd, not the one it started in', () => {
    const h = home()
    rollout(h, [
      { type: 'session_meta', payload: { cwd: '/w/a' } },
      { type: 'turn_context', payload: { cwd: '/w/a' } },
      { type: 'turn_context', payload: { cwd: '/w/b' } },
    ])
    expect(codexSessionFolder({ agent: 'codex', id: '01a180f4' }, h)).toBe('/w/b')
  })

  it('keeps a folder longer than a display field', () => {
    const h = home()
    const long = `/w/${'d'.repeat(300)}`
    rollout(h, [{ type: 'session_meta', payload: { cwd: long } }])
    expect(codexSessionFolder({ agent: 'codex', id: '01a180f4' }, h)).toBe(long)
  })

  it('names nothing for Claude, whose transcript follows a cd the session does not resume in, or a missing record', () => {
    const h = home()
    mkdirSync(join(h, '.claude', 'projects', '-w'), { recursive: true })
    writeFileSync(
      join(h, '.claude', 'projects', '-w', 'abc-1.jsonl'),
      `${JSON.stringify({ type: 'user', cwd: '/w/sub' })}\n`,
    )
    expect(codexSessionFolder({ agent: 'claude', id: 'abc-1' }, h)).toBeNull()
    expect(codexSessionFolder({ agent: 'codex', id: 'missing' }, h)).toBeNull()
  })
})

describe('readRange', () => {
  it('refuses a symlink and a FIFO without blocking', () => {
    const h = home()
    writeFileSync(join(h, 'real.jsonl'), 'a\n')
    symlinkSync(join(h, 'real.jsonl'), join(h, 'link.jsonl'))
    execFileSync('mkfifo', [join(h, 'pipe.jsonl')])
    expect(() => readRange(join(h, 'link.jsonl'), true, 100)).toThrow()
    expect(() => readRange(join(h, 'pipe.jsonl'), true, 100)).toThrow()
    expect(readRange(join(h, 'real.jsonl'), true, 100)).toEqual(['a', ''])
  })

  it('reads the tail asynchronously with the same refusals', async () => {
    const h = home()
    writeFileSync(join(h, 'real.jsonl'), 'a\n')
    symlinkSync(join(h, 'real.jsonl'), join(h, 'link.jsonl'))
    execFileSync('mkfifo', [join(h, 'pipe.jsonl')])
    await expect(readTail(join(h, 'link.jsonl'), 100)).rejects.toThrow()
    await expect(readTail(join(h, 'pipe.jsonl'), 100)).rejects.toThrow()
    expect(await readTail(join(h, 'real.jsonl'), 100)).toEqual({
      lines: ['a', ''],
      truncated: false,
    })
  })
})
