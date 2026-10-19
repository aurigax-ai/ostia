import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceEntry } from '../panes/paneList'
import { ownSnippets } from '../workspaces/snippets'
import { type PhoneSnippetDeps, snippetList } from './phoneSnippets'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

describe('snippet.list', () => {
  let root: string
  let workDir: string
  let deps: PhoneSnippetDeps

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
    const workspaces: WorkspaceEntry[] = [
      { workspaceId: 'w1', name: 'One', kind: 'agent', workDir, state: 'idle' },
      { workspaceId: 'pad', name: 'Pad', kind: 'scratch', workDir: root, state: 'idle' },
    ]
    const snippetDeps = {
      userDir,
      roots: () => [root],
      workDirForWorkspace: (id?: string) => (id === 'w1' ? workDir : undefined),
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
          { name: 'Test', command: 'pnpm test', arguments: [], source: 'workspace' },
          {
            name: 'Deploy',
            description: 'Ship it',
            command: 'deploy --token [REDACTED] {{env}}',
            arguments: [{ name: 'env', defaultValue: 'prod' }],
            source: 'user',
          },
        ],
      },
    })
    const userOnly = (await snippetList({}, deps)) as { result: { snippets: { name: string }[] } }
    expect(userOnly.result.snippets.map((s) => s.name)).toEqual(['Deploy'])
  })

  it('PHS-C2 refuses a scratch or unknown workspace', async () => {
    for (const sessionId of ['pad', 'gone', 7]) {
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
})
