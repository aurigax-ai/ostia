import { describe, expect, it, vi } from 'vitest'
import { AGENT_HOOK_CONTEXT_MAX, AGENT_HOOK_INPUT_MAX } from '../../shared/agentPlugins'
import { type AgentHookIo, parseAgentHookArgs, runAgentHook } from './agentHook'

function io(
  result: Awaited<ReturnType<AgentHookIo['invoke']>>,
  input = '{"session_id":"s"}',
): AgentHookIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    readInput: async () => input,
    invoke: vi.fn(async () => result),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  }
}

describe('parseAgentHookArgs', () => {
  it('takes an extension id, its command, a known agent and a known event', () => {
    expect(parseAgentHookArgs(['kit', 'on-hook', 'claude', 'Stop'])).toEqual({
      extId: 'kit',
      command: 'on-hook',
      agent: 'claude',
      event: 'Stop',
    })
  })

  it.each([
    [['kit', 'on-hook', 'claude']],
    [['kit', 'on-hook', 'gemini', 'Stop']],
    [['kit', 'on-hook', 'claude', 'Whatever']],
    [['Kit', 'on-hook', 'claude', 'Stop']],
    [['kit', 'on hook', 'claude', 'Stop']],
    [['kit', 'on-hook', 'claude', 'Stop', 'extra']],
  ])('refuses %j', (args) => {
    expect(parseAgentHookArgs(args)).toBeNull()
  })
})

describe('runAgentHook', () => {
  it('passes the agent and event as argv and the hook JSON as stdin', async () => {
    const hook = io({ ok: true })
    expect(await runAgentHook(['kit', 'on-hook', 'codex', 'Stop'], hook)).toBe(0)
    expect(hook.invoke).toHaveBeenCalledWith({
      extId: 'kit',
      command: 'on-hook',
      args: { argv: ['codex', 'Stop'], stdin: '{"session_id":"s"}' },
    })
    expect(hook.lines).toEqual([])
  })

  it('wraps the extension’s text as added context at session start and prompt submit', async () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const hook = io({ ok: true, text: '  remember the checklist \n' })
      await runAgentHook(['kit', 'on-hook', 'claude', event], hook)
      expect(hook.lines.map((line) => JSON.parse(line))).toEqual([
        {
          hookSpecificOutput: { hookEventName: event, additionalContext: 'remember the checklist' },
        },
      ])
    }
  })

  it('never lets the extension answer for the agent: decisions it prints are dropped', async () => {
    const decision = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd']) {
      const hook = io({ ok: true, text: decision, data: { decision: 'block' } })
      expect(await runAgentHook(['kit', 'on-hook', 'claude', event], hook)).toBe(0)
      expect(hook.lines).toEqual([])
    }
    const start = io({ ok: true, text: decision })
    await runAgentHook(['kit', 'on-hook', 'claude', 'SessionStart'], start)
    expect(JSON.parse(start.lines[0] ?? '')).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: decision },
    })
  })

  it('caps the added context', async () => {
    const hook = io({ ok: true, text: 'x'.repeat(AGENT_HOOK_CONTEXT_MAX + 50) })
    await runAgentHook(['kit', 'on-hook', 'claude', 'SessionStart'], hook)
    const output = JSON.parse(hook.lines[0] ?? '')
    expect(output.hookSpecificOutput.additionalContext).toHaveLength(AGENT_HOOK_CONTEXT_MAX)
  })

  it('reports a failed command on stderr only', async () => {
    const hook = io({ ok: false, error: 'extension-disabled' })
    expect(await runAgentHook(['kit', 'on-hook', 'claude', 'SessionStart'], hook)).toBe(1)
    expect(hook.lines).toEqual([])
    expect(hook.errors).toEqual(['ostia agent-hook: kit on-hook failed (extension-disabled)'])
  })

  it('refuses hook input past the cap without calling the extension', async () => {
    const hook = io({ ok: true }, 'x'.repeat(AGENT_HOOK_INPUT_MAX + 1))
    expect(await runAgentHook(['kit', 'on-hook', 'claude', 'PostToolUse'], hook)).toBe(1)
    expect(hook.invoke).not.toHaveBeenCalled()
  })

  it('refuses bad arguments without reading stdin', async () => {
    const hook = io({ ok: true })
    const readInput = vi.fn(hook.readInput)
    expect(await runAgentHook(['kit'], { ...hook, readInput })).toBe(1)
    expect(readInput).not.toHaveBeenCalled()
  })
})
