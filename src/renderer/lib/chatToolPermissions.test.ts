import { describe, expect, it } from 'vitest'
import { READ_OUTSIDE_GRANT, decideTool, grantsAfter } from './chatToolPermissions'

const none = new Set<string>()

describe('decideTool', () => {
  it('runs read-only tools inside the workspace folder without asking', () => {
    expect(decideTool('read_file', 'read', none)).toEqual({ run: true })
  })

  it('asks before reading outside the folder, grantable for the chat', () => {
    expect(decideTool('read_file', 'read', none, true)).toEqual({
      run: false,
      kind: 'read-outside',
      grantKey: READ_OUTSIDE_GRANT,
    })
    expect(decideTool('list_directory', 'read', new Set([READ_OUTSIDE_GRANT]), true)).toEqual({
      run: true,
    })
  })

  it('asks for acting tools and MCP tools until the chat grants that tool', () => {
    expect(decideTool('open_url', 'act', none)).toEqual({
      run: false,
      kind: 'act',
      grantKey: 'open_url',
    })
    expect(decideTool('open_url', 'act', new Set(['open_url']))).toEqual({ run: true })
    expect(decideTool('open_file', 'act', new Set(['open_url']))).toMatchObject({ run: false })
    expect(decideTool('mcp__fs__read', 'mcp', none)).toEqual({
      run: false,
      kind: 'mcp',
      grantKey: 'mcp__fs__read',
    })
    expect(decideTool('mcp__fs__read', 'mcp', new Set(['mcp__fs__read']))).toEqual({ run: true })
  })

  it('always asks for writes and commands, with nothing to grant', () => {
    const all = new Set(['write_file', 'propose_command', READ_OUTSIDE_GRANT])
    expect(decideTool('write_file', 'confirm', all)).toEqual({
      run: false,
      kind: 'write',
      grantKey: null,
    })
    expect(decideTool('propose_command', 'confirm', all)).toEqual({
      run: false,
      kind: 'command',
      grantKey: null,
    })
  })
})

describe('grantsAfter', () => {
  it('adds a grant only for Allow for this chat on a grantable decision', () => {
    const act = decideTool('open_url', 'act', none)
    expect([...grantsAfter(none, act, { approved: true, scope: 'chat' })]).toEqual(['open_url'])
    expect([...grantsAfter(none, act, { approved: true, scope: 'once' })]).toEqual([])
    expect([...grantsAfter(none, act, { approved: false })]).toEqual([])
    const write = decideTool('write_file', 'confirm', none)
    expect([...grantsAfter(none, write, { approved: true, scope: 'chat' })]).toEqual([])
  })
})
