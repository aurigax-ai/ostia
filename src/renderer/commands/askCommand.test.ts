import { afterEach, describe, expect, it } from 'vitest'
import { useAssistStore } from '../stores/assistStore'
import { useUIStore } from '../stores/uiStore'
import { ASK_COMMAND_ID, startAskCommand } from './askCommand'
import { commands } from './registry'

describe('startAskCommand', () => {
  let stop: (() => void) | null = null

  afterEach(() => {
    stop?.()
    stop = null
    if (commands.has(ASK_COMMAND_ID)) commands.unregister(ASK_COMMAND_ID)
    useAssistStore.setState({ availability: {} })
    useUIStore.setState({ paletteOpen: false, paletteMode: 'search' })
  })

  it('registers Ask Assistant only while an extension serves chat', () => {
    stop = startAskCommand()
    expect(commands.has(ASK_COMMAND_ID)).toBe(false)

    useAssistStore.setState({
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } },
      },
    })
    expect(commands.has(ASK_COMMAND_ID)).toBe(true)

    useAssistStore.setState({ availability: {} })
    expect(commands.has(ASK_COMMAND_ID)).toBe(false)
  })

  it('opens the palette in Ask mode when run', async () => {
    useAssistStore.setState({
      availability: {
        chat: { extId: 'assistant', name: 'Assistant', ref: { extId: 'assistant' } },
      },
    })
    stop = startAskCommand()

    await commands.exec(ASK_COMMAND_ID)

    expect(useUIStore.getState()).toMatchObject({ paletteOpen: true, paletteMode: 'ask' })
  })
})
