import { describe, expect, it, vi } from 'vitest'
import type { PermissionChoice } from '../../shared/agents/agentPermissions'
import { runPermissionHook } from './permissionHook'

const SUGGESTION = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
  behavior: 'allow',
  destination: 'localSettings',
}

function payload(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    ...extra,
  })
}

function io(input: string, decision: PermissionChoice | null) {
  const out: string[] = []
  const ask = vi.fn().mockResolvedValue({ decision })
  return {
    out,
    ask,
    io: { readInput: async () => input, ask, out: (l: string) => out.push(l), err: vi.fn() },
  }
}

describe('runPermissionHook', () => {
  it('returns Claude’s allow decision and the suggested rule for Always allow', async () => {
    const t = io(payload({ permission_suggestions: [SUGGESTION] }), 'always')
    expect(await runPermissionHook(['claude'], t.io)).toBe(0)
    expect(t.ask).toHaveBeenCalledWith({
      agent: 'claude',
      tool: 'Bash',
      detail: 'npm test',
      always: true,
    })
    expect(JSON.parse(t.out[0] ?? '')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [SUGGESTION] },
      },
    })
  })

  it('returns a deny decision', async () => {
    const t = io(payload(), 'deny')
    await runPermissionHook(['codex'], t.io)
    expect(JSON.parse(t.out[0] ?? '').hookSpecificOutput.decision.behavior).toBe('deny')
  })

  it('never offers Codex Always allow, which its hooks cannot carry', async () => {
    const t = io(payload({ permission_suggestions: [SUGGESTION] }), 'once')
    await runPermissionHook(['codex'], t.io)
    expect(t.ask.mock.calls[0]?.[0]).toMatchObject({ always: false })
    expect(JSON.parse(t.out[0] ?? '').hookSpecificOutput.decision).toEqual({ behavior: 'allow' })
  })

  it('prints nothing when nobody answered, so the agent shows its own prompt', async () => {
    const t = io(payload(), null)
    expect(await runPermissionHook(['claude'], t.io)).toBe(0)
    expect(t.out).toEqual([])
  })

  it('prints nothing and asks nothing for input it cannot read', async () => {
    const t = io('not json', 'once')
    expect(await runPermissionHook(['claude'], t.io)).toBe(0)
    expect(t.ask).not.toHaveBeenCalled()
    expect(t.out).toEqual([])
  })

  it('refuses an unknown agent', async () => {
    const t = io(payload(), 'once')
    expect(await runPermissionHook(['gemini'], t.io)).toBe(1)
    expect(t.ask).not.toHaveBeenCalled()
  })
})
