import { describe, expect, it } from 'vitest'
import type { CommandDescriptor } from '../shared/types'
import { commandHelp, wantsHelp } from './commandHelp'

const descriptor = (argsSchema: CommandDescriptor['argsSchema']): CommandDescriptor => ({
  id: 'pane.close',
  title: 'Close pane',
  category: null,
  hidden: false,
  argsSchema,
  resultSchema: null,
  capabilities: [],
  target: 'pane' as CommandDescriptor['target'],
})

describe('wantsHelp', () => {
  it('accepts --help and -h only', () => {
    expect(wantsHelp('--help')).toBe(true)
    expect(wantsHelp('-h')).toBe(true)
    expect(wantsHelp('{"id":"x"}')).toBe(false)
    expect(wantsHelp('-1')).toBe(false)
    expect(wantsHelp(undefined)).toBe(false)
  })
})

describe('commandHelp', () => {
  it('prints the title, usage and the args schema', () => {
    const text = commandHelp(descriptor({ type: 'object', properties: { id: { type: 'string' } } }))
    expect(text).toContain('pane.close: Close pane')
    expect(text).toContain('usage: ostia pane.close [json-args]')
    expect(text).toContain('"properties"')
  })

  it('says so when the command takes no arguments', () => {
    expect(commandHelp(descriptor(null))).toContain('takes no arguments')
  })
})
