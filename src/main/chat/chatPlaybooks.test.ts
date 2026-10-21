import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: vi.fn(),
  },
}))

const { registerChatToolsIpc } = await import('./chatToolsIpc')

let base: string

function skill(folder: string, name: string, body: string): void {
  mkdirSync(join(folder, name), { recursive: true })
  writeFileSync(
    join(folder, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "About ${name}."\ndisable-model-invocation: true\n---\n\n${body}\n`,
  )
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-chat-pb-'))
  handlers.clear()
  skill(join(base, 'mine'), 'pdf', 'Read the PDF.')
  skill(join(base, 'playbooks'), 'coordinator', 'Plan.\n\n$ARGUMENTS')
  registerChatToolsIpc({
    roots: () => [base],
    settings: () => ({ skillFolders: [join(base, 'mine')], mcpServers: [] }),
    playbooksFolder: () => join(base, 'playbooks'),
    mcp: {} as never,
    secrets: {} as never,
    oauth: {} as never,
    grants: {} as never,
    onGrants: vi.fn(),
  })
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args)

describe('playbooks in Chat and the Agent pane', () => {
  it('keeps playbooks out of the model-facing skill list and load_skill', () => {
    expect((call('chatTools:skills') as { name: string }[]).map((s) => s.name)).toEqual(['pdf'])
    expect(call('chatTools:load-skill', 'coordinator')).toEqual({
      ok: false,
      error: 'unknown-skill',
    })
  })

  it('lists them for the composer’s own slash menu', () => {
    expect((call('chatTools:playbooks') as { name: string }[]).map((s) => s.name)).toEqual([
      'coordinator',
    ])
  })

  it('turns a typed /name and task into the playbook text, taking the task literally', () => {
    expect(call('chatTools:playbook-prompt', 'coordinator', 'ship $& it')).toBe(
      '\nPlan.\n\nship $& it\n',
    )
    expect(call('chatTools:playbook-prompt', 'coordinator', 4)).toBe('\nPlan.\n\n\n')
    expect(call('chatTools:playbook-prompt', 'pdf', 'x')).toBeNull()
    expect(call('chatTools:playbook-prompt', '../x', 'x')).toBeNull()
  })
})
