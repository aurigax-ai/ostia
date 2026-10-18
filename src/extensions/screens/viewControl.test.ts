import { describe, expect, it, vi } from 'vitest'
import { ViewControl } from './viewControl'

function setup(answers: { takeover?: boolean; giveback?: boolean } = {}) {
  const view = { viewOnly: false, focusOnClick: true, focus: vi.fn() }
  const before = { focus: vi.fn() }
  let active: { focus: () => void } | null = before
  const takeover = vi.fn(async () => answers.takeover ?? true)
  const giveback = vi.fn(async () => answers.giveback ?? true)
  const control = new ViewControl({ view, active: () => active, takeover, giveback })
  return {
    view,
    before,
    takeover,
    giveback,
    control,
    setActive: (el: { focus: () => void } | null) => {
      active = el
    },
  }
}

describe('the live view controls', () => {
  it('SCX-C8 starts view-only, so clicks and keys in the view send nothing and do not take focus', () => {
    const { view, takeover } = setup()
    expect(view.viewOnly).toBe(true)
    expect(view.focusOnClick).toBe(false)
    expect(view.focus).not.toHaveBeenCalled()
    expect(takeover).not.toHaveBeenCalled()
  })

  it('SCX-C7 puts the keyboard in the view on Take over, and gives it back where it was on Give back', async () => {
    const { view, before, control, takeover, giveback, setActive } = setup()
    expect(await control.takeOver()).toBe(true)
    expect(takeover).toHaveBeenCalledTimes(1)
    expect(view.viewOnly).toBe(false)
    expect(view.focusOnClick).toBe(true)
    expect(view.focus).toHaveBeenCalledTimes(1)
    expect(control.holding).toBe(true)
    setActive(view)
    expect(await control.giveBack()).toBe(true)
    expect(giveback).toHaveBeenCalledTimes(1)
    expect(view.viewOnly).toBe(true)
    expect(view.focusOnClick).toBe(false)
    expect(before.focus).toHaveBeenCalledTimes(1)
    expect(control.holding).toBe(false)
  })

  it('SCX-C8 stays view-only and moves no focus when the service refuses the take over', async () => {
    const { view, control } = setup({ takeover: false })
    expect(await control.takeOver()).toBe(false)
    expect(view.viewOnly).toBe(true)
    expect(view.focusOnClick).toBe(false)
    expect(view.focus).not.toHaveBeenCalled()
  })

  it('goes back to view-only when the service gave the input back on its own', async () => {
    const { view, control, before } = setup()
    await control.takeOver()
    control.released()
    expect(view.viewOnly).toBe(true)
    expect(control.holding).toBe(false)
    expect(before.focus).not.toHaveBeenCalled()
  })
})
