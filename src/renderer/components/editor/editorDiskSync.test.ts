import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleSaves } from '@/lib/files/pendingSaves'
import type { monaco } from '@/lib/monaco/setup'

vi.mock('@/lib/monaco/setup', () => ({ monaco: {} }))
vi.mock('@/lib/lsp/client', () => ({ documentSaved: vi.fn() }))

const { createEditorSave } = await import('./editorDiskSync')

const FILE = '/w/notes.md'

function fakeEditor(): monaco.editor.IStandaloneCodeEditor {
  const model = {
    uri: { path: FILE, toString: () => `file://${FILE}` },
    getAlternativeVersionId: () => 2,
    getValue: () => 'text',
  }
  return {
    getModel: () => model,
    getAction: () => null,
  } as unknown as monaco.editor.IStandaloneCodeEditor
}

describe('createEditorSave', () => {
  afterEach(() => {
    vi.mocked(window.ostia.fs.write).mockReset()
    vi.mocked(window.ostia.fs.write).mockResolvedValue(true)
  })

  it('registers a running save so a close waits for it', async () => {
    let finish: (ok: boolean) => void = () => {}
    vi.mocked(window.ostia.fs.read).mockResolvedValue({ ok: false, error: 'missing' })
    vi.mocked(window.ostia.fs.write).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const save = createEditorSave({
      editor: fakeEditor(),
      saveRef: { current: async () => {} },
      setUnsavedPath: () => {},
      setRemoteProblem: () => {},
      setDiskBar: () => {},
    })
    void save()
    await vi.waitFor(() => {
      expect(window.ostia.fs.write).toHaveBeenCalledWith(FILE, 'text')
    })
    let settled = false
    const waiting = settleSaves([FILE], 5_000).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    finish(true)
    await waiting
    expect(settled).toBe(true)
  })
})
