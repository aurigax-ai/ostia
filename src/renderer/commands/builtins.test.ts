import { describe, expect, it } from 'vitest'
import { registerBuiltinCommands } from './builtins'
import { commands } from './registry'

describe('builtins declare targets', () => {
  it('non-pane commands are target:none, pane commands stay target:active', () => {
    registerBuiltinCommands()
    const byId = Object.fromEntries(commands.describe().map((c) => [c.id, c]))

    expect(byId['session.new'].target).toBe('none')
    expect(byId['palette.toggle'].target).toBe('none')
    expect(byId['view.toggleRail'].target).toBe('none')
    expect(byId['app.openSettings'].target).toBe('none')

    expect(byId['pane.split'].target).toBe('active')
  })
})
