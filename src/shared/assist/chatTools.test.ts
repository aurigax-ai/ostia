import { describe, expect, it } from 'vitest'
import { chatMarkdown, normalizeChatSession } from './chatSessions'
import {
  MCP_SERVERS_MAX,
  isMcpSecretKey,
  mcpToolName,
  parseChatToolSettings,
  parseMcpServer,
} from './chatTools'

describe('parseMcpServer', () => {
  it('accepts an argv server or an http(s) server, never both or neither', () => {
    expect(parseMcpServer({ name: 'fs', command: ['npx', '-y', 'srv'] })).toEqual({
      name: 'fs',
      enabled: true,
      command: ['npx', '-y', 'srv'],
      env: {},
      secrets: [],
      disabledTools: [],
    })
    expect(parseMcpServer({ name: 'web', url: 'https://mcp.example.com/mcp' })?.url).toBe(
      'https://mcp.example.com/mcp',
    )
    expect(parseMcpServer({ name: 'x', url: 'https://a', command: ['a'] })).toBeNull()
    expect(parseMcpServer({ name: 'x' })).toBeNull()
    expect(parseMcpServer({ name: 'x', url: 'file:///etc/passwd' })).toBeNull()
    expect(parseMcpServer({ name: 'x', url: 'javascript:alert(1)' })).toBeNull()
  })

  it('refuses a shell string, empty argv, control characters and bad names', () => {
    expect(parseMcpServer({ name: 'x', command: 'npx srv' })).toBeNull()
    expect(parseMcpServer({ name: 'x', command: [] })).toBeNull()
    expect(parseMcpServer({ name: 'x', command: ['a', 'b\nc'] })).toBeNull()
    expect(parseMcpServer({ name: '../x', command: ['a'] })).toBeNull()
    expect(parseMcpServer({ name: '', command: ['a'] })).toBeNull()
  })

  it('keeps valid env keys for argv servers and secret names per transport', () => {
    const stdio = parseMcpServer({
      name: 's',
      command: ['a'],
      env: { GOOD: '1', 'bad-key': '2', __proto__: '3', NUM: 4 },
      secrets: ['TOKEN', 'Bad-Header', 'TOKEN'],
    })
    expect(stdio?.env).toEqual({ GOOD: '1' })
    expect(stdio?.secrets).toEqual(['TOKEN'])
    const http = parseMcpServer({
      name: 'h',
      url: 'http://127.0.0.1:1/mcp',
      env: { A: '1' },
      secrets: ['Authorization', 'X Bad'],
    })
    expect(http?.env).toEqual({})
    expect(http?.secrets).toEqual(['Authorization'])
    expect(isMcpSecretKey('stdio', 'Authorization')).toBe(true)
    expect(isMcpSecretKey('http', 'MY_TOKEN')).toBe(false)
  })
})

describe('parseChatToolSettings', () => {
  it('drops duplicates, caps the list and keeps only absolute skill folders', () => {
    const many = Array.from({ length: MCP_SERVERS_MAX + 3 }, (_, i) => ({
      name: `s${i}`,
      command: ['a'],
    }))
    const parsed = parseChatToolSettings({
      mcpServers: [{ name: 's0', command: ['dup'] }, ...many],
      skillFolders: ['/abs/skills', 'relative', '/a/../b', '/abs/skills'],
    })
    expect(parsed.mcpServers).toHaveLength(MCP_SERVERS_MAX)
    expect(parsed.mcpServers[0].command).toEqual(['dup'])
    expect(parsed.skillFolders).toEqual(['/abs/skills'])
    expect(parseChatToolSettings(null)).toEqual({ mcpServers: [], skillFolders: [] })
  })
})

describe('mcpToolName', () => {
  it('builds a provider-safe name under 64 chars', () => {
    expect(mcpToolName('fs', 'read.file')).toBe('mcp__fs__read_file')
    expect(mcpToolName('s', 'x'.repeat(100))).toHaveLength(64)
  })
})

describe('chat sessions with tool parts', () => {
  const session = (parts: unknown[]) =>
    normalizeChatSession({
      id: 'c1',
      title: 'Tools',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'u', role: 'user', parts: [{ type: 'text', text: 'read it' }] },
        { id: 'a', role: 'assistant', parts },
      ],
    })

  it('keeps an oversized tool part by clipping its strings instead of dropping it', () => {
    const big = 'x'.repeat(100_000)
    const saved = session([
      {
        type: 'dynamic-tool',
        toolName: 'read_file',
        toolCallId: 't1',
        state: 'output-available',
        input: { path: '/p/a' },
        output: { text: big },
      },
    ])
    const part = saved?.messages[1].parts[0] as unknown as {
      output: { text: string }
      state: string
    }
    expect(part.state).toBe('output-available')
    expect(part.output.text.length).toBeLessThan(big.length)
    expect(part.output.text.endsWith('…[truncated]')).toBe(true)
  })

  it('exports tool calls, their results, errors and denials to Markdown in order', () => {
    const saved = session([
      { type: 'step-start' },
      { type: 'text', text: 'Let me look.' },
      {
        type: 'dynamic-tool',
        toolName: 'read_file',
        toolCallId: 't1',
        state: 'output-available',
        input: { path: '/p/a' },
        output: 'hello',
      },
      {
        type: 'dynamic-tool',
        toolName: 'write_file',
        toolCallId: 't2',
        state: 'output-denied',
        input: { path: '/p/a', content: 'x' },
        approval: { id: 'ap', approved: false },
      },
      {
        type: 'dynamic-tool',
        toolName: 'mcp__fake__fail',
        toolCallId: 't3',
        state: 'output-error',
        input: {},
        errorText: 'boom',
      },
      { type: 'step-start' },
      { type: 'text', text: 'Done.' },
    ])
    const md = chatMarkdown(saved as NonNullable<typeof saved>)
    const order = [
      'Let me look.',
      '`read_file`: done',
      'hello',
      '`write_file`: denied',
      '`mcp__fake__fail`: failed',
      'boom',
      'Done.',
    ]
    let at = 0
    for (const piece of order) {
      const next = md.indexOf(piece, at)
      expect(next, piece).toBeGreaterThanOrEqual(at)
      at = next
    }
  })
})
