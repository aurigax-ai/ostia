import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeModel, createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const { applyTextEdits, applyWorkspaceEdit, editsStayInside, openModelEdits, textEditsByUri } =
  await import('./workspaceEdit')

const edit = (line: number, start: number, end: number, newText: string) => ({
  range: { start: { line, character: start }, end: { line, character: end } },
  newText,
})

beforeEach(() => {
  fake.models.clear()
})

describe('applyTextEdits', () => {
  it('applies edits by position, whatever order they come in', () => {
    const text = 'one two\nthree four\n'
    expect(applyTextEdits(text, [edit(0, 0, 3, 'ONE'), edit(1, 6, 10, 'FOUR')])).toBe(
      'ONE two\nthree FOUR\n',
    )
    expect(applyTextEdits(text, [edit(1, 6, 10, 'FOUR'), edit(0, 0, 3, 'ONE')])).toBe(
      'ONE two\nthree FOUR\n',
    )
  })

  it('inserts, deletes across lines and clamps positions past the end', () => {
    expect(applyTextEdits('ab\ncd', [edit(0, 1, 1, 'X')])).toBe('aXb\ncd')
    expect(applyTextEdits('ab\ncd', [edit(0, 1, 1, 'X'), edit(0, 1, 1, 'Y')])).toBe('aXYb\ncd')
    expect(
      applyTextEdits('ab\ncd\nef', [
        {
          range: { start: { line: 0, character: 1 }, end: { line: 2, character: 1 } },
          newText: '-',
        },
      ]),
    ).toBe('a-f')
    expect(applyTextEdits('ab', [edit(0, 99, 99, '!'), edit(9, 0, 0, '?')])).toBe('ab!?')
  })
})

describe('textEditsByUri', () => {
  it('collects text edits from changes and documentChanges', () => {
    const byUri = textEditsByUri({
      changes: { 'file:///p/a.txt': [edit(0, 0, 1, 'x')] },
      documentChanges: [
        { textDocument: { uri: 'file:///p/b.txt', version: 3 }, edits: [edit(1, 0, 1, 'y')] },
        { textDocument: { uri: 'file:///p/a.txt', version: null }, edits: [edit(2, 0, 1, 'z')] },
      ],
    })
    expect([...(byUri ?? new Map())]).toEqual([
      ['file:///p/b.txt', [edit(1, 0, 1, 'y')]],
      ['file:///p/a.txt', [edit(2, 0, 1, 'z'), edit(0, 0, 1, 'x')]],
    ])
  })

  it('refuses an edit that creates, renames or deletes files', () => {
    expect(
      textEditsByUri({ documentChanges: [{ kind: 'create', uri: 'file:///p/new.txt' }] }),
    ).toBeNull()
    expect(
      textEditsByUri({
        documentChanges: [{ kind: 'rename', oldUri: 'file:///p/a', newUri: 'file:///p/b' }],
      }),
    ).toBeNull()
  })
})

describe('applyWorkspaceEdit', () => {
  it('edits an open document through its model and a closed file on disk', async () => {
    const model = fake.addModel(new FakeModel('/p/open.txt', 'open one'))
    vi.mocked(window.ostia.fs.read).mockResolvedValue({
      ok: true,
      version: 'v1',
      text: 'closed one\n',
    })
    vi.mocked(window.ostia.fs.write).mockResolvedValue(true)
    const applied = await applyWorkspaceEdit(
      {
        changes: {
          'file:///p/open.txt': [edit(0, 5, 8, 'two')],
          'file:///p/closed.txt': [edit(0, 7, 10, 'two')],
        },
      },
      '/p',
    )
    expect(applied).toBe(true)
    expect(model.getValue()).toBe('open two')
    expect(window.ostia.fs.read).toHaveBeenCalledTimes(1)
    expect(window.ostia.fs.read).toHaveBeenCalledWith('/p/closed.txt')
    expect(window.ostia.fs.write).toHaveBeenCalledWith('/p/closed.txt', 'closed two\n')
  })

  it('reports failure when a closed file cannot be read or written, and for file operations', async () => {
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'missing' })
    expect(
      await applyWorkspaceEdit({ changes: { 'file:///p/x.txt': [edit(0, 0, 0, 'x')] } }, '/p'),
    ).toBe(false)
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
    expect(
      await applyWorkspaceEdit(
        { documentChanges: [{ kind: 'delete', uri: 'file:///p/a.txt' }] },
        '/p',
      ),
    ).toBe(false)
  })

  it('refuses the whole edit when any file is outside the folder the server may edit', async () => {
    const model = fake.addModel(new FakeModel('/p/open.txt', 'open one'))
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: true, version: 'v1', text: 'secret\n' })
    for (const uri of [
      'file:///home/u/.zshrc',
      'file:///p/../home/u/.zshrc',
      'file:///p-other/x.txt',
      'untitled:///p/x.txt',
    ]) {
      expect(
        await applyWorkspaceEdit(
          {
            changes: { 'file:///p/open.txt': [edit(0, 0, 4, 'OPEN')], [uri]: [edit(0, 0, 0, 'x')] },
          },
          '/p',
        ),
        uri,
      ).toBe(false)
    }
    expect(
      await applyWorkspaceEdit(
        { changes: { 'file:///p/open.txt': [edit(0, 0, 4, 'OPEN')] } },
        null,
      ),
    ).toBe(false)
    expect(model.getValue()).toBe('open one')
    expect(window.ostia.fs.write).not.toHaveBeenCalled()
    expect(editsStayInside(new Map(), null)).toBe(true)
  })
})

describe('openModelEdits', () => {
  it('returns editor edits only for documents that are open', () => {
    fake.addModel(new FakeModel('/p/open.txt', 'text'))
    const edits = openModelEdits(
      new Map([
        ['file:///p/open.txt', [edit(0, 0, 4, 'TEXT')]],
        ['file:///p/closed.txt', [edit(0, 0, 1, 'x')]],
      ]),
    )
    expect(edits.edits).toHaveLength(1)
    expect(edits.edits[0]).toMatchObject({
      textEdit: {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 },
        text: 'TEXT',
      },
      versionId: undefined,
    })
  })
})
