import { describe, expect, it } from 'vitest'
import {
  type HookSource,
  PROMPT_TEXT_MAX,
  RECAP_TEXT_MAX,
  parseHookEvent,
  parseStoredEvent,
  recapOf,
} from './hookEvent'

const source = (event: HookSource['event'], agent: HookSource['agent'] = 'claude'): HookSource => ({
  agent,
  event,
  pane: 'pane-1',
  now: 1000,
})

const base = { v: 1, t: 1000, pane: 'pane-1', agent: 'claude', session: 's-1' }

describe('parseHookEvent', () => {
  it('keeps the first non-empty line of the prompt, capped', () => {
    const prompt = `\n  fix the login page ${'x'.repeat(400)}\nand then the footer`
    const event = parseHookEvent(
      source('UserPromptSubmit'),
      JSON.stringify({ session_id: 's-1', prompt }),
    )
    expect(event).toMatchObject({ ...base, kind: 'prompt' })
    expect(event?.text?.startsWith('fix the login page xxx')).toBe(true)
    expect([...(event?.text ?? '')]).toHaveLength(PROMPT_TEXT_MAX)
    expect(event?.text).not.toContain('footer')
  })

  it('names a tool call by kind and target and never takes its output', () => {
    const tool = (name: string, input: unknown, cwd = '/w/shop') =>
      parseHookEvent(
        source('PreToolUse'),
        JSON.stringify({
          session_id: 's-1',
          cwd,
          tool_name: name,
          tool_input: input,
          tool_response: { stdout: 'printed output' },
        }),
      )
    expect(tool('Edit', { file_path: '/w/shop/src/cart.ts', old_string: 'secret body' })).toEqual({
      ...base,
      kind: 'tool',
      tool: 'edit',
      text: 'src/cart.ts',
    })
    expect(tool('Write', { file_path: '/etc/hosts', content: 'file body' })).toMatchObject({
      tool: 'edit',
      text: '/etc/hosts',
    })
    expect(tool('Bash', { command: 'pnpm test\necho second line' })).toMatchObject({
      tool: 'command',
      text: 'pnpm test',
    })
    expect(tool('Grep', { pattern: 'TODO', path: '/w/shop' })).toMatchObject({
      tool: 'search',
      text: 'TODO',
    })
    expect(tool('Read', { file_path: '/w/shop/README.md' })).toMatchObject({
      tool: 'read',
      text: 'README.md',
    })
    expect(tool('Task', { description: 'Review the diff', prompt: 'long prompt' })).toMatchObject({
      tool: 'subagent',
      text: 'Review the diff',
    })
    expect(tool('WebFetch', { url: 'https://example.com/a' })).toMatchObject({
      tool: 'web',
      text: 'https://example.com/a',
    })
    expect(tool('mcp__board__move', { card: 'A-1' })).toEqual({
      ...base,
      kind: 'tool',
      tool: 'other',
      text: 'mcp__board__move',
    })
    expect(tool('Edit', {})).toEqual({ ...base, kind: 'tool', tool: 'edit' })
    expect(JSON.stringify(tool('Bash', { command: 'ls' }))).not.toContain('printed output')
  })

  it('reads a Codex command the same way', () => {
    const event = parseHookEvent(
      source('PreToolUse', 'codex'),
      JSON.stringify({
        session_id: '01a1381e-890b',
        turn_id: 't-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
    )
    expect(event).toEqual({
      v: 1,
      t: 1000,
      pane: 'pane-1',
      agent: 'codex',
      session: '01a1381e-890b',
      kind: 'tool',
      tool: 'command',
      text: 'echo hi',
    })
  })

  it('takes the closing message of a stop as the recap, cut to a few lines', () => {
    const message = 'Fixed the cart total.\n\nTests pass.\nThree\nFour\nFive'
    expect(
      parseHookEvent(
        source('Stop'),
        JSON.stringify({ session_id: 's-1', last_assistant_message: message }),
      ),
    ).toEqual({
      ...base,
      kind: 'stop',
      text: 'Fixed the cart total.\nTests pass.\nThree\nFour…',
    })
    expect([...recapOf('y'.repeat(5000))]).toHaveLength(RECAP_TEXT_MAX)
  })

  it('records a stop without a recap when the agent sent no closing message', () => {
    expect(parseHookEvent(source('Stop'), JSON.stringify({ session_id: 's-1' }))).toEqual({
      ...base,
      kind: 'stop',
    })
  })

  it('drops control characters, bad session ids, other events and input that is not an object', () => {
    const event = parseHookEvent(
      source('UserPromptSubmit'),
      JSON.stringify({ session_id: '../../etc', prompt: 'a\u001b[31mb\u0007c' }),
    )
    expect(event).toEqual({ ...base, session: '', kind: 'prompt', text: 'a [31mb c' })
    expect(parseHookEvent(source('SessionStart'), '{}')).toBeNull()
    expect(parseHookEvent(source('Stop'), 'not json')).toBeNull()
    expect(parseHookEvent(source('Stop'), '[]')).toBeNull()
    expect(parseHookEvent(source('PreToolUse'), '{}')).toBeNull()
  })
})

describe('parseStoredEvent', () => {
  it('accepts what parseHookEvent writes and refuses anything else', () => {
    const stored = { ...base, kind: 'tool', tool: 'edit', text: 'a.ts' }
    expect(parseStoredEvent(stored)).toEqual(stored)
    expect(parseStoredEvent({ ...stored, extra: 'x' })).toEqual(stored)
    expect(parseStoredEvent({ ...stored, v: 2 })).toBeNull()
    expect(parseStoredEvent({ ...stored, agent: 'other' })).toBeNull()
    expect(parseStoredEvent({ ...stored, tool: 'rm' })).toBeNull()
    expect(parseStoredEvent({ ...stored, kind: 'output' })).toBeNull()
    expect(parseStoredEvent({ ...stored, text: 4 })).toBeNull()
    expect(parseStoredEvent(null)).toBeNull()
  })
})
