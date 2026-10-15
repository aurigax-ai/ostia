import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_HOOK_INPUT_MAX } from './agentPlugins'
import { parseAgentStop } from './agentStop'

const fs = { openSync, readFileSync }
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, openSync: vi.fn(real.openSync), readFileSync: vi.fn(real.readFileSync) }
})

function claudeStop(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: '0f6b2a3c-aaaa-4bbb-8ccc-0123456789ab',
    transcript_path: '/home/u/.claude/projects/x/0f6b2a3c.jsonl',
    cwd: '/home/u/proj',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done. All tests pass.',
    ...extra,
  })
}

function codexStop(): string {
  return JSON.stringify({
    session_id: '019a-codex-session',
    turn_id: 'turn-7',
    cwd: '/home/u/proj',
    hook_event_name: 'Stop',
    model: 'gpt-5',
    last_assistant_message: 'Reviewed: VERDICT pass',
  })
}

describe('parseAgentStop', () => {
  it('GRF-C129 reads the session and closing message of Claude Code and Codex', () => {
    expect(parseAgentStop('claude', claudeStop())).toEqual({
      sessionId: '0f6b2a3c-aaaa-4bbb-8ccc-0123456789ab',
      message: 'Done. All tests pass.',
      backgroundWork: false,
    })
    expect(parseAgentStop('codex', codexStop())).toEqual({
      sessionId: '019a-codex-session',
      turnId: 'turn-7',
      message: 'Reviewed: VERDICT pass',
      backgroundWork: false,
    })
    expect(
      parseAgentStop('claude', claudeStop({ background_tasks: [{ id: 'b1', status: 'running' }] }))
        ?.backgroundWork,
    ).toBe(true)
    expect(
      parseAgentStop('claude', claudeStop({ session_crons: [{ id: 'c1' }] }))?.backgroundWork,
    ).toBe(true)
  })

  it('GRF-C130 no message without the field, nothing from bad or large input, and no transcript read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stop-'))
    const transcript = join(dir, 'transcript.jsonl')
    writeFileSync(transcript, '{"message":"from the transcript"}\n')
    const { last_assistant_message: _m, ...rest } = JSON.parse(claudeStop()) as Record<
      string,
      unknown
    >
    const without = parseAgentStop(
      'claude',
      JSON.stringify({ ...rest, transcript_path: transcript }),
    )
    expect(without?.message).toBeUndefined()
    expect(without?.sessionId).toBe('0f6b2a3c-aaaa-4bbb-8ccc-0123456789ab')
    expect(parseAgentStop('claude', 'not json')).toBeNull()
    expect(
      parseAgentStop('claude', claudeStop({ pad: 'x'.repeat(AGENT_HOOK_INPUT_MAX) })),
    ).toBeNull()
    const opened = [
      ...vi.mocked(fs.openSync).mock.calls.map((call) => call[0]),
      ...vi.mocked(fs.readFileSync).mock.calls.map((call) => call[0]),
    ]
    expect(opened.filter((path) => path === transcript)).toEqual([])
  })
})
