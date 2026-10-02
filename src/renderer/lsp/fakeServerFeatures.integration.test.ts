import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node'
import type { Command, Diagnostic } from 'vscode-languageserver-protocol'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))
vi.mock('vscode-jsonrpc/browser', async () => await import('vscode-jsonrpc/node'))

const { APPLY_CODE_ACTION_COMMAND, refreshCodeLenses, registerProviders } = await import(
  './providers'
)
const { LspSession } = await import('./session')
const { toWorkspaceSymbolHits } = await import('./workspaceSymbols')

const FAKE_SERVER = resolve(__dirname, '../../../test/fixtures/lsp/fake-server.mjs')
const TEXT = ['fn alpha BEGIN', '  body ERROR', 'END', 'fn beta', 'tail'].join('\n')

type Provide = (...args: unknown[]) => Promise<unknown>
type Session = InstanceType<typeof LspSession>

interface Started {
  session: Session
  model: FakeModel
  uri: string
  root: string
  published: Diagnostic[][]
  changes: { count: number }
  recorded: () => { method: string; params?: Record<string, unknown> }[]
  sync: () => void
}

const cleanups: (() => void)[] = []

async function start(args: string[], text = TEXT): Promise<Started> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-lsp-features-')))
  const recordFile = join(root, 'record.jsonl')
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    FAKE_SERVER,
    `--record=${recordFile}`,
    ...args,
  ])
  const published: Diagnostic[][] = []
  const changes = { count: 0 }
  let registration: { dispose: () => void } | null = null
  const model = new FakeModel(join(root, 'main.txt'), text)
  const sync = (): void => {
    registration?.dispose()
    registration = registerProviders(
      'plaintext',
      session.effectiveCapabilities(),
      (candidate, method) =>
        candidate === (model as never) && session.supports(method, model.uri.toString())
          ? session
          : undefined,
    )
  }
  const session: Session = new LspSession(
    {
      sessionId: 's1',
      serverKey: 'fake-lang/fake',
      root,
      editRoot: root,
      languageId: 'fake',
      initializationOptions: {},
    },
    new StreamMessageReader(proc.stdout),
    new StreamMessageWriter(proc.stdin),
    {
      onDiagnostics: (_uri, diagnostics) => published.push(diagnostics),
      onClosed: () => {},
      onCapabilitiesChanged: () => {
        changes.count += 1
        sync()
      },
      onCodeLensRefresh: refreshCodeLenses,
    },
  )
  cleanups.push(() => {
    registration?.dispose()
    session.dispose()
    proc.kill()
    rmSync(root, { recursive: true, force: true })
  })
  await session.initialize()
  fake.addModel(model)
  sync()
  session.openDocument(model as never, 'fake')
  return {
    session,
    model,
    uri: model.uri.toString(),
    root,
    published,
    changes,
    sync,
    recorded: () =>
      readFileSync(recordFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }),
  }
}

function provider(kind: string, method: string): Provide {
  const [registration] = fake.active(kind)
  if (!registration) throw new Error(`no ${kind} registered`)
  return registration.provider[method] as Provide
}

function kinds(): string[] {
  return [
    ...new Set(
      fake.registrations
        .filter((r) => !r.disposed)
        .map((r) => r.kind)
        .sort(),
    ),
  ]
}

function messages(published: Diagnostic[][]): string[] {
  return (published.at(-1) ?? []).map((d) => d.message as string)
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  fake.registrations.length = 0
  fake.models.clear()
})

describe('folding ranges and code lens against a real fake language server', () => {
  it('folds the regions the server reports, as 1-based lines with their kind', async () => {
    const { model } = await start(['--caps=folding'])
    expect(kinds()).toEqual(['FoldingRangeProvider'])
    expect(await provider('FoldingRangeProvider', 'provideFoldingRanges')(model, {})).toEqual([
      { start: 1, end: 3, kind: { value: 'region' } },
    ])
  })

  it('resolves a lens, runs its advertised command through executeCommand and refreshes on request', async () => {
    const { model, session, recorded } = await start(['--caps=codeLens,executeCommand'])
    const lensProvider = fake.active('CodeLensProvider')[0].provider
    const refreshed = vi.fn()
    ;(lensProvider.onDidChange as (cb: () => void) => unknown)(refreshed)
    const list = (await provider('CodeLensProvider', 'provideCodeLenses')(model)) as {
      lenses: { range: unknown; command?: { id: string; title: string; arguments?: unknown[] } }[]
    }
    expect(list.lenses.map((lens) => lens.command?.title)).toEqual([
      undefined,
      'alpha: client only',
      undefined,
      'beta: client only',
    ])
    expect(list.lenses[1].command).toEqual({ id: '', title: 'alpha: client only' })
    const resolved = (await provider('CodeLensProvider', 'resolveCodeLens')(
      model,
      list.lenses[0],
    )) as { command: { id: string; title: string; arguments: [unknown, Command] } }
    expect(resolved.command.title).toBe('Run alpha (0 runs)')
    expect(resolved.command.id).toBe(APPLY_CODE_ACTION_COMMAND)
    expect(resolved.command.arguments[0]).toBe(session)
    fake.commands.get(APPLY_CODE_ACTION_COMMAND)?.(null, ...resolved.command.arguments)
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    const run = recorded().find((entry) => entry.method === 'workspace/executeCommand')
    expect(run?.params).toEqual({ command: 'fake.countRun', arguments: ['alpha'] })
    const again = (await provider('CodeLensProvider', 'resolveCodeLens')(
      model,
      list.lenses[0],
    )) as { command: { title: string } }
    expect(again.command.title).toBe('Run alpha (1 runs)')
  })

  it('shows every lens as text when the server advertises no commands', async () => {
    const { model } = await start(['--caps=codeLens'])
    const list = (await provider('CodeLensProvider', 'provideCodeLenses')(model)) as {
      lenses: unknown[]
    }
    const resolved = (await provider('CodeLensProvider', 'resolveCodeLens')(
      model,
      list.lenses[0],
    )) as { command: { id: string; title: string } }
    expect(resolved.command).toEqual({ id: '', title: 'Run alpha (0 runs)' })
  })
})

describe('pull diagnostics against a real fake language server', () => {
  it('pulls on open and after an edit, sending the previous result id', async () => {
    const { model, published, recorded, uri } = await start(['--caps=pullDiagnostics'])
    await vi.waitFor(() => expect(messages(published)).toEqual(['fake error on line 2']), {
      timeout: 10_000,
    })
    model.edit({ startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 5 }, 'WARN')
    await vi.waitFor(
      () => expect(messages(published)).toEqual(['fake error on line 2', 'fake warning on line 5']),
      { timeout: 10_000 },
    )
    const pulls = recorded().filter((entry) => entry.method === 'textDocument/diagnostic')
    expect(pulls[0].params).toEqual({ textDocument: { uri }, identifier: 'fake' })
    expect(pulls[1].params?.previousResultId).toEqual(expect.stringMatching(/^r-/))
    expect(recorded().some((e) => e.method === 'textDocument/publishDiagnostics')).toBe(false)
  })

  it('shows each diagnostic once when the server both pushes and answers pulls', async () => {
    const { published, session, uri } = await start([
      '--caps=pullDiagnostics',
      '--diagnostics=both',
    ])
    await vi.waitFor(() => expect(published.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
    expect(messages(published)).toEqual(['fake error on line 2'])
    expect(session.diagnosticsFor(uri)).toHaveLength(1)
  })

  it('pulls again when the server asks for a refresh and keeps the markers on an unchanged answer', async () => {
    const { published, recorded, session } = await start(['--caps=pullDiagnostics,executeCommand'])
    await vi.waitFor(() => expect(messages(published)).toEqual(['fake error on line 2']), {
      timeout: 10_000,
    })
    const pullCount = (): number =>
      recorded().filter((entry) => entry.method === 'textDocument/diagnostic').length
    const before = pullCount()
    await session.request('workspace/executeCommand', { command: 'fake.refreshDiagnostics' })
    await vi.waitFor(() => expect(pullCount()).toBe(before + 1), { timeout: 10_000 })
    await vi.waitFor(
      () =>
        expect(
          recorded()
            .filter((entry) => entry.method === '$report')
            .map((entry) => (entry as { kind?: string }).kind),
        ).toEqual(['full', 'unchanged']),
      { timeout: 10_000 },
    )
    expect(messages(published)).toEqual(['fake error on line 2'])
  })

  it('asks again when the server cancels a pull and wants it retried', async () => {
    const { published, recorded } = await start(
      ['--caps=pullDiagnostics'],
      'BUSY first\nthen ERROR',
    )
    await vi.waitFor(() => expect(messages(published)).toEqual(['fake error on line 2']), {
      timeout: 10_000,
    })
    expect(recorded().filter((e) => e.method === 'textDocument/diagnostic')).toHaveLength(2)
  })
})

describe('dynamic registration against a real fake language server', () => {
  it('registers providers for features the server registers after initialize, and drops them on unregister', async () => {
    const { changes, model, published, recorded, session } = await start([
      '--caps=',
      '--late-caps=hover,folding,codeLens,executeCommand,workspaceSymbols,pullDiagnostics',
    ])
    expect(session.capabilities.hoverProvider).toBeUndefined()
    await vi.waitFor(() => expect(changes.count).toBe(1), { timeout: 10_000 })
    expect(kinds()).toEqual(['CodeLensProvider', 'FoldingRangeProvider', 'HoverProvider'])
    expect(
      await provider('HoverProvider', 'provideHover')(model, { lineNumber: 1, column: 5 }),
    ).toMatchObject({ contents: [{ value: 'fake hover: **alpha**' }] })
    expect(session.runsCommand('fake.countRun')).toBe(true)

    await vi.waitFor(
      () => expect(recorded().some((e) => e.method === 'textDocument/diagnostic')).toBe(true),
      { timeout: 10_000 },
    )
    await vi.waitFor(() => expect(messages(published)).toEqual(['fake error on line 2']), {
      timeout: 10_000,
    })

    const symbols = toWorkspaceSymbolHits(
      'fake-lang/fake',
      await session.request('workspace/symbol', { query: 'bet' }),
    )
    expect(symbols).toMatchObject([
      { name: 'beta', container: 'fake', path: model.uri.path, line: 4, column: 4 },
    ])

    await session.request('workspace/executeCommand', {
      command: 'fake.unregister',
      arguments: ['hover', 'folding'],
    })
    await vi.waitFor(() => expect(kinds()).toEqual(['CodeLensProvider']), { timeout: 10_000 })
  })

  it('serves a late feature only to documents its selector matches', async () => {
    const { changes, session, uri } = await start(['--caps=', '--late-caps=txtOnlyDefinition'])
    await vi.waitFor(() => expect(changes.count).toBe(1), { timeout: 10_000 })
    expect(session.supports('textDocument/definition', uri)).toBe(true)
    expect(session.supports('textDocument/definition', uri.replace('.txt', '.md'))).toBe(false)
  })
})
