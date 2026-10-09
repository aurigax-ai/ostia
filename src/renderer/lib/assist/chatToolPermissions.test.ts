import { READ_OUTSIDE_GRANT } from '@shared/assist/chatTools'
import { describe, expect, it } from 'vitest'
import {
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  type ToolCheck,
  alwaysGrantAfter,
  decideTool,
  grantsAfter,
  readsOutsideUnasked,
} from './chatToolPermissions'

const none = new Set<string>()

function check(patch: Partial<ToolCheck> & Pick<ToolCheck, 'name' | 'access'>): ToolCheck {
  return { mode: 'ask', grants: none, standing: none, ...patch }
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
    ['repository', { repository: true }],
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

describe('standing grants', () => {
  it('runs a tool always allowed in an earlier chat without asking, in the same scope', () => {
    const standing = new Set(['open_url', 'mcp__fake__echo', READ_OUTSIDE_GRANT])
    expect(decideTool(check({ name: 'open_url', access: 'act', standing }))).toEqual({ run: true })
    expect(decideTool(check({ name: 'mcp__fake__echo', access: 'mcp', standing }))).toEqual({
      run: true,
    })
    expect(
      decideTool(check({ name: 'read_file', access: 'read', outside: true, standing })),
    ).toEqual({ run: true })
    expect(readsOutsideUnasked({ grants: none, standing })).toBe(true)
  })

  it('still asks outside the granted scope', () => {
    const standing = new Set(['open_url', 'mcp__fake__echo'])
    expect(decideTool(check({ name: 'open_file', access: 'act', standing }))).toMatchObject({
      run: false,
      grantKey: 'open_file',
    })
    expect(decideTool(check({ name: 'mcp__other__echo', access: 'mcp', standing }))).toMatchObject({
      run: false,
      grantKey: 'mcp__other__echo',
    })
    expect(
      decideTool(check({ name: 'read_file', access: 'read', outside: true, standing })),
    ).toMatchObject({ run: false, kind: 'read-outside' })
    expect(readsOutsideUnasked({ grants: none, standing })).toBe(false)
  })

  it('never lets a standing grant run a proposed command or skip the mode for edits', () => {
    const standing = new Set(['propose_command', 'edit_file', 'write_file'])
    expect(decideTool(check({ name: 'propose_command', access: 'command', standing }))).toEqual({
      run: false,
      kind: 'command',
      grantKey: null,
    })
    for (const name of ['edit_file', 'write_file']) {
      expect(decideTool(check({ name, access: 'write', standing }))).toMatchObject({
        run: false,
        reason: 'ask-mode',
      })
    }
  })

  it('makes a standing grant only for Always allow on a grantable decision', () => {
    const always = { approved: true, scope: 'always' } as const
    const act = decideTool(check({ name: 'open_url', access: 'act' }))
    expect(alwaysGrantAfter(act, always)).toBe('open_url')
    expect([...grantsAfter(none, act, always)]).toEqual([])
    expect(alwaysGrantAfter(act, { approved: true, scope: 'chat' })).toBeNull()
    expect(alwaysGrantAfter(act, { approved: true, scope: 'once' })).toBeNull()
    expect(alwaysGrantAfter(act, { approved: false })).toBeNull()
    const read = decideTool(check({ name: 'read_file', access: 'read', outside: true }))
    expect(alwaysGrantAfter(read, always)).toBe(READ_OUTSIDE_GRANT)
    for (const decision of [
      decideTool(check({ name: 'propose_command', access: 'command' })),
      decideTool(check({ name: 'edit_file', access: 'write' })),
      decideTool(check({ name: 'write_file', access: 'write' })),
    ]) {
      expect(alwaysGrantAfter(decision, always)).toBeNull()
    }
  })
})
