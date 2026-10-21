import { describe, expect, it } from 'vitest'
import { normalizeTurnReport, TURN_OUTPUT_MAX, TURN_PROMPT_MAX, turnReportOf } from './turnHook'

const hook = (payload: unknown): string => JSON.stringify(payload)

describe('turnReportOf', () => {
  it('PHT-C1 keeps the prompt as plain text, capped, and nothing else of the payload', () => {
    const report = turnReportOf(
      'UserPromptSubmit',
      hook({ prompt: 'fix\u0007 the build\r\nnow', session_id: 's', transcript_path: '/home/u/t' }),
    )
    expect(report).toEqual({ kind: 'prompt', text: 'fix the build\nnow' })
    const long = turnReportOf('UserPromptSubmit', hook({ prompt: 'x'.repeat(TURN_PROMPT_MAX + 5) }))
    expect(long).toEqual({ kind: 'prompt', text: 'x'.repeat(TURN_PROMPT_MAX) })
    expect(turnReportOf('UserPromptSubmit', hook({ prompt: '  ' }))).toBeNull()
    expect(turnReportOf('UserPromptSubmit', 'not json')).toBeNull()
  })

  it('PHT-C2 turns a finished tool call into its kind and first-line target, never its input body', () => {
    expect(
      turnReportOf(
        'PostToolUse',
        hook({ tool_name: 'Write', tool_input: { file_path: '/w/src/a.ts', content: 'SECRET' } }),
      ),
    ).toEqual({ kind: 'step', step: 'edit', target: '/w/src/a.ts' })
    expect(
      turnReportOf(
        'PostToolUse',
        hook({ tool_name: 'Read', tool_input: { file_path: '/w/a' }, tool_response: 'body' }),
      ),
    ).toEqual({ kind: 'step', step: 'read', target: '/w/a' })
    expect(
      turnReportOf('PostToolUse', hook({ tool_name: 'mcp__x__y', tool_input: { a: 1 } })),
    ).toEqual({ kind: 'step', step: 'other', target: 'mcp__x__y' })
    expect(turnReportOf('PostToolUse', hook({ tool_input: {} }))).toBeNull()
  })

  it('PHT-C3 keeps a command as its first line, exit code and the tail of its plain output only', () => {
    const output = `${'a'.repeat(TURN_OUTPUT_MAX)}\u001b[31mFAIL\u001b[0m`
    const step = turnReportOf(
      'PostToolUse',
      hook({
        tool_name: 'Bash',
        tool_input: { command: '\npnpm test\nrm -rf /tmp/x' },
        tool_response: { stdout: output, stderr: 'oops', exit_code: 1 },
      }),
    )
    expect(step).toMatchObject({ kind: 'step', step: 'command', target: 'pnpm test', exitCode: 1 })
    const text = (step as { output: string }).output
    expect(text.endsWith('FAIL\noops')).toBe(true)
    expect(text).not.toContain('\u001b')
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(TURN_OUTPUT_MAX)
    expect(
      turnReportOf(
        'PostToolUse',
        hook({ tool_name: 'shell', tool_input: { command: ['ls', '-la'] } }),
      ),
    ).toEqual({ kind: 'step', step: 'command', target: 'ls -la' })
  })

  it('PHT-C4 keeps the Stop message as the final message', () => {
    expect(
      turnReportOf('Stop', hook({ last_assistant_message: 'Done.\n\nAll tests pass.' })),
    ).toEqual({
      kind: 'stop',
      message: 'Done.\n\nAll tests pass.',
    })
    expect(turnReportOf('Stop', hook({}))).toEqual({ kind: 'stop' })
  })

  it('PHT-C5 normalizes what reaches main the same way and refuses anything else', () => {
    expect(normalizeTurnReport({ kind: 'step', step: 'shell-escape', target: 'x' })).toBeNull()
    expect(normalizeTurnReport({ kind: 'result', output: 'x' })).toBeNull()
    expect(
      normalizeTurnReport({ kind: 'step', step: 'command', exitCode: 999, output: '\u001b[1mok' }),
    ).toEqual({ kind: 'step', step: 'command', output: 'ok' })
    expect(
      normalizeTurnReport({ kind: 'step', step: 'edit', target: 'a\nb', output: 'x' }),
    ).toEqual({
      kind: 'step',
      step: 'edit',
      target: 'a b',
    })
  })
})
