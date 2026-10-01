import { describe, expect, it } from 'vitest'
import {
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  READ_OUTSIDE_GRANT,
  type ToolCheck,
  decideTool,
  grantsAfter,
} from './chatToolPermissions'

const none = new Set<string>()

function check(patch: Partial<ToolCheck> & Pick<ToolCheck, 'name' | 'access'>): ToolCheck {
  return { mode: 'ask', grants: none, ...patch }
}

describe('decideTool', () => {
  it('starts every chat in Ask mode', () => {
    expect(DEFAULT_CHAT_MODE).toBe('ask')
  })

  it.each(CHAT_MODES)('runs read-only tools inside the workspace folder in %s mode', (mode) => {
    expect(decideTool(check({ name: 'read_file', access: 'read', mode }))).toEqual({ run: true })
  })

  it.each(CHAT_MODES)('asks before reading outside the folder in %s mode', (mode) => {
    expect(decideTool(check({ name: 'read_file', access: 'read', mode, outside: true }))).toEqual({
      run: false,
      kind: 'read-outside',
      grantKey: READ_OUTSIDE_GRANT,
    })
    expect(
      decideTool(
        check({
          name: 'list_directory',
          access: 'read',
          mode,
          outside: true,
          grants: new Set([READ_OUTSIDE_GRANT]),
        }),
      ),
    ).toEqual({ run: true })
  })

  it.each(CHAT_MODES)(
    'asks for acting tools and MCP tools until the chat grants that tool in %s mode',
    (mode) => {
      expect(decideTool(check({ name: 'open_url', access: 'act', mode }))).toEqual({
        run: false,
        kind: 'act',
        grantKey: 'open_url',
      })
      expect(
        decideTool(check({ name: 'open_url', access: 'act', mode, grants: new Set(['open_url']) })),
      ).toEqual({ run: true })
      expect(
        decideTool(
          check({ name: 'open_file', access: 'act', mode, grants: new Set(['open_url']) }),
        ),
      ).toMatchObject({ run: false })
      expect(decideTool(check({ name: 'mcp__fs__read', access: 'mcp', mode }))).toEqual({
        run: false,
        kind: 'mcp',
        grantKey: 'mcp__fs__read',
      })
      expect(
        decideTool(
          check({
            name: 'mcp__fs__write',
            access: 'mcp',
            mode,
            grants: new Set(['mcp__fs__write']),
          }),
        ),
      ).toEqual({ run: true })
    },
  )

  it.each(CHAT_MODES)('asks for every command in %s mode, with nothing to grant', (mode) => {
    const grants = new Set(['propose_command', 'write_file', 'edit_file', READ_OUTSIDE_GRANT])
    expect(decideTool(check({ name: 'propose_command', access: 'command', mode, grants }))).toEqual(
      { run: false, kind: 'command', grantKey: null },
    )
  })

  it('asks for every edit in Ask mode, with nothing to grant', () => {
    const grants = new Set(['write_file', 'edit_file'])
    for (const name of ['write_file', 'edit_file']) {
      expect(decideTool(check({ name, access: 'write', grants }))).toEqual({
        run: false,
        kind: 'write',
        grantKey: null,
        reason: 'ask-mode',
      })
    }
  })

  it('applies an edit inside the workspace folder without asking in Write mode', () => {
    for (const name of ['write_file', 'edit_file']) {
      expect(decideTool(check({ name, access: 'write', mode: 'write' }))).toEqual({ run: true })
    }
  })

  it.each([
    ['outside', { outside: true }],
    ['symlink', { symlink: true }],
    ['unsaved', { unsaved: true }],
  ] as const)('still asks in either mode when the edit is %s', (reason, flags) => {
    for (const mode of CHAT_MODES) {
      const decision = decideTool(check({ name: 'edit_file', access: 'write', mode, ...flags }))
      expect(decision).toEqual({ run: false, kind: 'write', grantKey: null, reason })
    }
  })

  it('names the outside folder first when several reasons apply', () => {
    expect(
      decideTool(
        check({
          name: 'write_file',
          access: 'write',
          mode: 'write',
          outside: true,
          symlink: true,
          unsaved: true,
        }),
      ),
    ).toMatchObject({ run: false, reason: 'outside' })
  })
})

describe('grantsAfter', () => {
  it('adds a grant only for Allow for this chat on a grantable decision', () => {
    const act = decideTool(check({ name: 'open_url', access: 'act' }))
    expect([...grantsAfter(none, act, { approved: true, scope: 'chat' })]).toEqual(['open_url'])
    expect([...grantsAfter(none, act, { approved: true, scope: 'once' })]).toEqual([])
    expect([...grantsAfter(none, act, { approved: false })]).toEqual([])
    const write = decideTool(check({ name: 'write_file', access: 'write' }))
    expect([...grantsAfter(none, write, { approved: true, scope: 'chat' })]).toEqual([])
  })
})
