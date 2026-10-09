import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { CmuxImportReport } from '../../shared/cmuxSession'
import {
  CMUX_IMPORT_USAGE,
  formatCmuxImport,
  parseCmuxImportArgs,
  runCmuxImportVerb,
} from './cmuxImport'

const REPORT: CmuxImportReport = {
  path: '/home/u/Library/Application Support/cmux/session-com.cmuxterm.app.json',
  imported: [
    { workspaceId: 'w1', name: 'App', panes: 6, window: 0 },
    { workspaceId: 'w2', name: 'Ops', panes: 2, window: 1 },
  ],
  skipped: [{ name: 'Office', reason: 'exists', window: 0 }],
  notCarried: [
    { workspace: 'App', pane: 'Refactor', loss: 'agent-resume', detail: 'codex' },
    { workspace: 'Ops', loss: 'canvas' },
  ],
}

function connReturning(result: unknown): {
  conn: MessageConnection
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn().mockResolvedValue(result)
  return { conn: { sendRequest: send } as unknown as MessageConnection, send }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseCmuxImportArgs', () => {
  it('resolves a session file against the current folder', () => {
    expect(parseCmuxImportArgs(['backup/session.json'], '/home/u')).toEqual({
      path: '/home/u/backup/session.json',
      json: false,
    })
    expect(parseCmuxImportArgs(['--json'], '/home/u')).toEqual({ json: true })
  })

  it('refuses more than one file and unknown flags', () => {
    expect(() => parseCmuxImportArgs(['a.json', 'b.json'], '/home/u')).toThrow(CMUX_IMPORT_USAGE)
    expect(() => parseCmuxImportArgs(['--force'], '/home/u')).toThrow()
  })
})

describe('formatCmuxImport', () => {
  it('lists what was imported, skipped and not carried over', () => {
    expect(formatCmuxImport(REPORT)).toEqual([
      `read ${REPORT.path}`,
      'imported\tApp\t6 panes',
      'imported\tOps\t2 panes',
      'skipped\tOffice\talready in Ostia',
      'not carried over:',
      '  running programs are not restarted: every terminal starts a new shell in its folder',
      '  App > Refactor: codex session not started; press Resume in the pane to continue it',
      '  Ops: canvas layout; it opens as splits',
    ])
  })

  it('says so when there was nothing new', () => {
    const report: CmuxImportReport = { ...REPORT, imported: [], notCarried: [] }

    expect(formatCmuxImport(report)).toEqual([
      `read ${REPORT.path}`,
      'skipped\tOffice\talready in Ostia',
      'nothing new to import',
    ])
  })
})

describe('runCmuxImportVerb', () => {
  it('runs the import command with the resolved file and prints the report', async () => {
    const { conn, send } = connReturning({ ok: true, result: REPORT })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const code = await runCmuxImportVerb(conn, ['s.json'], '/home/u')

    expect(code).toBe(0)
    expect(send).toHaveBeenCalledWith('command.exec', {
      id: 'workspace.importCmux',
      args: { path: '/home/u/s.json' },
    })
    expect(log.mock.calls.map((c) => c[0])).toEqual(formatCmuxImport(REPORT))
  })

  it('prints the report as JSON with --json', async () => {
    const { conn, send } = connReturning({ ok: true, result: REPORT })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runCmuxImportVerb(conn, ['--json'], '/home/u')

    expect(send).toHaveBeenCalledWith('command.exec', { id: 'workspace.importCmux', args: {} })
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(REPORT)
  })

  it('fails with the app’s reason when the import is refused', async () => {
    const { conn } = connReturning({
      ok: false,
      error: { code: 'command-failed', message: 'not-found: no cmux session file there' },
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await runCmuxImportVerb(conn, [], '/home/u')

    expect(code).toBe(1)
    expect(error).toHaveBeenCalledWith(
      'ostia workspace import-cmux: not-found: no cmux session file there',
    )
  })
})
