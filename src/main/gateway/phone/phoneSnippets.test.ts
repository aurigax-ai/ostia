import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEntry } from '../../panes/paneList'
import { ownSnippets } from '../../workspaces/snippets'
import { type PhoneSnippetDeps, snippetList } from './phoneSnippets'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

describe('snippet.list', () => {
  let root: string
  let workDir: string
  let deps: PhoneSnippetDeps
  let workspaces: WorkspaceEntry[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ostia-phone-snippets-'))
    const userDir = join(root, 'user')
    workDir = join(root, 'project')
    const workspaceDir = join(workDir, '.ostia', 'snippets')
    mkdirSync(userDir, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(
      join(userDir, 'deploy.yaml'),
      'name: Deploy\ncommand: deploy --token hunter2 {{env}}\ndescription: Ship it\narguments:\n  - name: env\n    default_value: prod\n',
    )
    writeFileSync(join(workspaceDir, 'test.yaml'), 'name: Test\ncommand: pnpm test\n')
    workspaces = [
      { workspaceId: 'w1', name: 'One', kind: 'agent', workDir, state: 'idle' },
      { workspaceId: 'pad', name: 'Pad', kind: 'scratch', workDir: root, state: 'idle' },
      { workspaceId: 'box', name: 'Box', kind: 'agent', workDir, state: 'idle', sandboxed: true },
      { workspaceId: 'mgr', name: 'Manager', kind: 'manager', workDir, state: 'idle' },
    ]
    const snippetDeps = {
      userDir,
      roots: () => [root],
      workDirForWorkspace: (id?: string) =>
        id === 'w1' ? workDir : id === 'w2' ? join(root, 'linked') : undefined,
      extensionSnippets: () => [
        { extId: 'kit', snippets: [{ name: 'Ext', command: 'ext', tags: [], arguments: [] }] },
      ],
    }
    deps = {
      listWorkspaces: async () => workspaces,
      ownSnippets: (workspaceId) => ownSnippets(snippetDeps, workspaceId),
      redact: vi.fn(async (text: string) => text.replace('hunter2', '[REDACTED]')),
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('PHS-C1 lists only the human’s user and workspace snippets, every text redacted', async () => {
    expect(await snippetList({ sessionId: 'w1' }, deps)).toEqual({
      ok: true,
      result: {
        snippets: [
          {
            name: 'Deploy',
            description: 'Ship it',
            command: 'deploy --token [REDACTED] {{env}}',
            arguments: [{ name: 'env', defaultValue: 'prod' }],
            source: 'user',
          },
          { name: 'Test', command: 'pnpm test', arguments: [], source: 'workspace' },
        ],
      },
    })
    const userOnly = (await snippetList({}, deps)) as { result: { snippets: { name: string }[] } }
    expect(userOnly.result.snippets.map((s) => s.name)).toEqual(['Deploy'])
  })

  it('PHS-C2 refuses a scratch, sandboxed, manager or unknown workspace', async () => {
    for (const sessionId of ['pad', 'box', 'mgr', 'gone', 7]) {
      expect(await snippetList({ sessionId }, deps)).toEqual({
        ok: false,
        code: -32602,
        message: 'unknown-session',
      })
    }
  })

  it('PHS-C3 sends nothing when redaction fails', async () => {
    deps.redact = vi.fn(async () => {
      throw new Error('scanner down')
    })
    expect(await snippetList({ sessionId: 'w1' }, deps)).toEqual({
      ok: false,
      code: -32603,
      message: 'redaction-failed',
    })
  })
  it('PHS-C4 never reads a FIFO, a symlinked file or a symlinked .ostia folder in the workspace', async () => {
    const dir = join(workDir, '.ostia', 'snippets')
    execFileSync('mkfifo', [join(dir, 'pipe.yaml')])
    writeFileSync(join(root, 'outside.yaml'), 'name: Outside\ncommand: cat secrets\n')
    symlinkSync(join(root, 'outside.yaml'), join(dir, 'link.yaml'))
    const linked = join(root, 'linked')
    mkdirSync(linked)
    mkdirSync(join(root, 'elsewhere', 'snippets'), { recursive: true })
    writeFileSync(join(root, 'elsewhere', 'snippets', 'x.yaml'), 'name: Via link\ncommand: x\n')
    symlinkSync(join(root, 'elsewhere'), join(linked, '.ostia'))
    workspaces.push({
      workspaceId: 'w2',
      name: 'Two',
      kind: 'agent',
      workDir: linked,
      state: 'idle',
    })

    const names = async (sessionId: string) =>
      (
        (await snippetList({ sessionId }, deps)) as { result: { snippets: { name: string }[] } }
      ).result.snippets.map((s) => s.name)
    expect(await names('w1')).toEqual(['Deploy', 'Test'])
    expect(await names('w2')).toEqual(['Deploy'])
  })

  it('PHS-C5 keeps the human’s own snippets when the workspace holds many', async () => {
    const dir = join(workDir, '.ostia', 'snippets')
    for (let file = 0; file < 5; file++) {
      const items = Array.from(
        { length: 50 },
        (_, i) => `- name: W${file}-${i}\n  command: echo ${i}`,
      )
      writeFileSync(join(dir, `many-${file}.yaml`), `${items.join('\n')}\n`)
    }
    const res = (await snippetList({ sessionId: 'w1' }, deps)) as {
      result: { snippets: { name: string; source: string }[] }
    }
    expect(res.result.snippets).toHaveLength(200)
    expect(res.result.snippets[0]).toMatchObject({ name: 'Deploy', source: 'user' })
  })
})
