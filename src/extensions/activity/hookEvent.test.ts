import { describe, expect, it } from 'vitest'
import {
  type HookSource,
  PROMPT_TEXT_MAX,
  parseHookEvent,
  parseStoredRecord,
  RECAP_TEXT_MAX,
  recapOf,
} from './hookEvent'

const source = (event: HookSource['event'], agent: HookSource['agent'] = 'claude'): HookSource => ({
  agent,
  event,
  pane: 'pane-1',
  now: 1000,
})

const base = { v: 2, t: 1000, pane: 'pane-1', agent: 'claude', session: 's-1' }
const anyId = expect.stringMatching(/^[a-z2-7]{10}$/)

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
      id: anyId,
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
      id: anyId,
      ...base,
      kind: 'tool',
      tool: 'other',
      text: 'mcp__board__move',
    })
    expect(tool('Edit', {})).toEqual({ ...base, id: anyId, kind: 'tool', tool: 'edit' })
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
      v: 2,
      id: anyId,
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
      id: anyId,
      ...base,
      kind: 'stop',
      text: 'Fixed the cart total.\nTests pass.\nThree\nFour…',
    })
    expect([...recapOf('y'.repeat(5000))]).toHaveLength(RECAP_TEXT_MAX)
  })

  it('records a stop without a recap when the agent sent no closing message', () => {
    expect(parseHookEvent(source('Stop'), JSON.stringify({ session_id: 's-1' }))).toEqual({
      ...base,
      id: anyId,
      kind: 'stop',
    })
  })

  it('drops control characters, bad session ids, other events and input that is not an object', () => {
    const event = parseHookEvent(
      source('UserPromptSubmit'),
      JSON.stringify({ session_id: '../../etc', prompt: 'a\u001b[31mb\u0007c' }),
    )
    expect(event).toEqual({ ...base, id: anyId, session: '', kind: 'prompt', text: 'a [31mb c' })
    expect(parseHookEvent(source('SessionStart'), '{}')).toBeNull()
    expect(parseHookEvent(source('Stop'), 'not json')).toBeNull()
    expect(parseHookEvent(source('Stop'), '[]')).toBeNull()
    expect(parseHookEvent(source('PreToolUse'), '{}')).toBeNull()
  })
})

describe('parseStoredRecord', () => {
  it('accepts what parseHookEvent writes and refuses anything else', () => {
    const stored = { ...base, id: 'abcdefghij', kind: 'tool', tool: 'edit', text: 'a.ts' }
    expect(parseStoredRecord(stored)).toEqual(stored)
    expect(parseStoredRecord({ ...stored, extra: 'x' })).toEqual(stored)
    expect(parseStoredRecord({ ...stored, v: 1 })).toBeNull()
    expect(parseStoredRecord({ ...stored, id: 'short' })).toBeNull()
    expect(parseStoredRecord({ ...stored, agent: 'other' })).toBeNull()
    expect(parseStoredRecord({ ...stored, tool: 'rm' })).toBeNull()
    expect(parseStoredRecord({ ...stored, kind: 'output' })).toBeNull()
    expect(parseStoredRecord({ ...stored, text: 4 })).toBeNull()
    expect(parseStoredRecord(null)).toBeNull()
  })

  it('accepts a note with its needs-you mark, link and done time, and refuses an empty or oversized one', () => {
    const note = {
      v: 2,
      t: 5,
      id: 'notenotena',
      pane: 'pane-1',
      kind: 'note',
      text: 'set the key',
      needsYou: true,
      link: '/w/README.md',
      doneAt: 9,
    }
    expect(parseStoredRecord(note)).toEqual(note)
    expect(parseStoredRecord({ ...note, needsYou: 'yes', doneAt: 'x' })).toEqual({
      v: 2,
      t: 5,
      id: 'notenotena',
      pane: 'pane-1',
      kind: 'note',
      text: 'set the key',
      link: '/w/README.md',
    })
    expect(parseStoredRecord({ ...note, text: '' })).toBeNull()
    expect(parseStoredRecord({ ...note, text: 'x'.repeat(2001) })).toBeNull()
  })
})

describe('parseStoredRecord for a host event', () => {
  const host = { v: 2, t: 1000, id: 'abcdefghij', pane: 'p1', kind: 'host', host: 'bus' }

  it('reads a host record and its metadata, and nothing it does not know', () => {
    expect(
      parseStoredRecord({
        ...host,
        from: 'p1',
        to: '@elsewhere',
        message: 'task',
        state: 'queued',
        ref: 'm1',
        text: 'secret',
      }),
    ).toEqual({
      ...host,
      from: 'p1',
      to: '@elsewhere',
      message: 'task',
      state: 'queued',
      ref: 'm1',
    })
  })

  it('refuses an unknown host kind, an unknown message kind and a field that is not a short string', () => {
    expect(parseStoredRecord({ ...host, host: 'typed' })).toBeNull()
    expect(parseStoredRecord({ ...host, message: 'secret' })).toBeNull()
    expect(parseStoredRecord({ ...host, from: 7 })).toBeNull()
    expect(parseStoredRecord({ ...host, folder: 'x'.repeat(201) })).toBeNull()
  })
})
