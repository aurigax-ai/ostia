import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { modeFor, resetChatTools } from '@/stores/assist/chatToolsStore'
import { ChatModeSelect } from './ChatComposerControls'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

afterEach(() => {
  cleanup()
  resetChatTools()
})

describe('ChatModeSelect', () => {
  it('names the second mode Write in a chat', async () => {
    render(<ChatModeSelect sessionId="s1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Mode: Ask' }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Write/ }))
    expect(modeFor('s1')).toBe('write')
    expect(screen.getByRole('button', { name: 'Mode: Write' })).toBeInTheDocument()
  })

  it('names it Allow in the Agent pane and stores the same write mode', async () => {
    render(
      <ChatModeSelect sessionId="s1" write={{ name: 'Allow', desc: 'Acts without asking.' }} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Mode: Ask' }))
    expect(await screen.findByText('Acts without asking.')).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /Write/ })).toBeNull()
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Allow/ }))
    expect(modeFor('s1')).toBe('write')
    expect(screen.getByRole('button', { name: 'Mode: Allow' })).toBeInTheDocument()
  })
})
