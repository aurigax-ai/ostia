import type * as Monaco from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import { holdModel } from './modelHolds'

function fakeModel(): Monaco.editor.ITextModel & { disposals: number } {
  const model = {
    disposals: 0,
    disposed: false,
    isDisposed() {
      return model.disposed
    },
    dispose() {
      model.disposed = true
      model.disposals += 1
    },
  }
  return model as unknown as Monaco.editor.ITextModel & { disposals: number }
}

describe('holdModel', () => {
  const clean = (): boolean => false
  const dirty = (): boolean => true

  it('disposes a clean model when its last holder lets go', () => {
    const model = fakeModel()
    const first = holdModel(model, clean)
    const second = holdModel(model, clean)
    first()
    expect(model.disposals).toBe(0)
    second()
    expect(model.disposals).toBe(1)
  })

  it('keeps a model with unsaved edits after its last holder lets go', () => {
    const model = fakeModel()
    holdModel(model, dirty)()
    expect(model.disposals).toBe(0)
  })

  it('counts a release only once', () => {
    const model = fakeModel()
    const first = holdModel(model, clean)
    holdModel(model, clean)
    first()
    first()
    expect(model.disposals).toBe(0)
  })

  it('disposes a kept model once it is held again and released clean', () => {
    const model = fakeModel()
    let unsaved = true
    holdModel(model, () => unsaved)()
    unsaved = false
    holdModel(model, () => unsaved)()
    expect(model.disposals).toBe(1)
  })

  it('leaves a model someone else already disposed alone', () => {
    const model = fakeModel()
    const release = holdModel(model, clean)
    model.dispose()
    release()
    expect(model.disposals).toBe(1)
  })
})
