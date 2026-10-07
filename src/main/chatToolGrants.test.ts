import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: vi.fn(),
  },
}))

const { ChatToolGrants } = await import('./chatToolGrants')
const { registerChatToolsIpc } = await import('./chatToolsIpc')

let base: string
let file: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-chat-grants-'))
  file = join(base, 'data', 'chat-tool-grants.json')
  handlers.clear()
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function sender(type: string) {
  return { sender: { getType: () => type } }
}

function register(grants: InstanceType<typeof ChatToolGrants>, onGrants = vi.fn()) {
  registerChatToolsIpc({
    roots: () => [base],
    settings: () => ({ skillFolders: [], mcpServers: [] }),
    mcp: {} as never,
    secrets: {} as never,
    oauth: {} as never,
    grants,
    onGrants,
  })
  return onGrants
}

describe('ChatToolGrants', () => {
  it('keeps an always-allowed tool in a private file and reads it back', () => {
    const grants = new ChatToolGrants(file)
    expect(grants.add('mcp__fake__echo')).toBe(true)
    expect(grants.add('read-outside')).toBe(true)
    expect(grants.add('open_url')).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new ChatToolGrants(file).list()).toEqual(['mcp__fake__echo', 'read-outside', 'open_url'])
  })

  it.each(['propose_command', 'edit_file', 'write_file', 'read_file', 'rm_rf', '', 42])(
    'never keeps %s',
    (key) => {
      const grants = new ChatToolGrants(file)
      expect(grants.add(key)).toBe(false)
      expect(grants.list()).toEqual([])
    },
  )

  it('drops keys a hand edit added that a card could never grant', () => {
    const path = join(base, 'hand.json')
    writeFileSync(path, JSON.stringify({ keys: ['open_file', 'propose_command', 'write_file', 7] }))
    expect(new ChatToolGrants(path).list()).toEqual(['open_file'])
  })

  it('removes a grant so the next load no longer has it', () => {
    const grants = new ChatToolGrants(file)
    grants.add('open_file')
    expect(grants.remove('open_file')).toBe(true)
    expect(grants.remove('open_file')).toBe(false)
    expect(new ChatToolGrants(file).list()).toEqual([])
  })
})

describe('chat tool grant IPC', () => {
  it('adds and removes only for a top-level window and tells every window', async () => {
    const grants = new ChatToolGrants(file)
    const onGrants = register(grants)
    const add = handlers.get('chatTools:grant-always')
    const remove = handlers.get('chatTools:remove-always-grant')
    expect(await add?.(sender('webview'), 'open_url')).toEqual([])
    expect(onGrants).not.toHaveBeenCalled()
    expect(await add?.(sender('window'), 'propose_command')).toEqual([])
    expect(await add?.(sender('window'), 'open_url')).toEqual(['open_url'])
    expect(onGrants).toHaveBeenLastCalledWith(['open_url'])
    expect(await handlers.get('chatTools:always-grants')?.(sender('window'))).toEqual(['open_url'])
    expect(await remove?.(sender('webview'), 'open_url')).toEqual(['open_url'])
    expect(await remove?.(sender('window'), 'open_url')).toEqual([])
    expect(onGrants).toHaveBeenLastCalledWith([])
  })

  it('is reached from nowhere but the chat tools IPC', () => {
    const root = join(__dirname, '..')
    const users: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8')
          if (/ChatToolGrants|grant-always|chat-tool-grants/.test(text)) {
            users.push(relative(root, path))
          }
        }
      }
    }
    walk(root)
    expect(users.sort()).toEqual([
      'main/app.ts',
      'main/chatToolGrants.ts',
      'main/chatToolsIpc.ts',
      'preload/index.ts',
    ])
  })
})
