import type { EditorLanguage } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  evaluations: 0,
  ready: Promise.resolve() as Promise<unknown>,
  applyEditorLanguages: vi.fn(),
}))

function mockRuntime(): void {
  vi.doMock('./monacoRuntime', () => {
    runtime.evaluations++
    return { monacoReady: runtime.ready, applyEditorLanguages: runtime.applyEditorLanguages }
  })
}

function nim(): EditorLanguage {
  return {
    extId: 'ext',
    id: 'nim',
    name: 'Nim',
    extensions: ['.nim'],
    filenames: [],
    configuration: {},
    grammar: { tokenizer: { root: [] } },
  }
}

async function freshLoader(): Promise<typeof import('./monacoLoader')> {
  vi.resetModules()
  return import('./monacoLoader')
}

describe('monacoLoader', () => {
  beforeEach(() => {
    runtime.evaluations = 0
    runtime.ready = Promise.resolve()
    runtime.applyEditorLanguages.mockReset()
    mockRuntime()
  })

  it('loads Monaco once for every caller and resolves them only once it is ready', async () => {
    let finish: () => void = () => {}
    runtime.ready = new Promise<void>((resolve) => (finish = resolve))
    const { loadMonaco, loadedMonaco } = await freshLoader()
    const first = loadMonaco()
    const second = loadMonaco()
    expect(first).toBe(second)
    let resolved = false
    void first.then(() => (resolved = true))
    await vi.dynamicImportSettled()
    expect(resolved).toBe(false)
    finish()
    const loaded = await first
    expect(loadedMonaco()).toBe(loaded)
    expect(runtime.evaluations).toBe(1)
  })

  it('tries again after a failed load', async () => {
    vi.doMock('./monacoRuntime', () => {
      throw new Error('chunk failed')
    })
    const { loadMonaco, loadedMonaco } = await freshLoader()
    expect(loadedMonaco()).toBeNull()
    await expect(loadMonaco()).rejects.toThrow()
    mockRuntime()
    await expect(loadMonaco()).resolves.toBeDefined()
    expect(loadedMonaco()).not.toBeNull()
  })

  it('maps contributed languages at once and hands them to Monaco only once it has loaded', async () => {
    vi.mocked(window.ostia.editorLanguages.load).mockResolvedValue([nim()])
    const { loadEditorLanguages, loadMonaco } = await freshLoader()
    const { fetchedEditorLanguages } = await import('./fetchedLanguages')
    const { fileLanguage } = await import('./language')
    await loadEditorLanguages()
    expect(fileLanguage('/p/a.nim')).toBe('nim')
    expect(fetchedEditorLanguages()).toEqual([nim()])
    expect(runtime.applyEditorLanguages).not.toHaveBeenCalled()
    await loadMonaco()
    await loadEditorLanguages()
    expect(runtime.applyEditorLanguages).toHaveBeenCalledExactlyOnceWith([nim()])
  })
})
