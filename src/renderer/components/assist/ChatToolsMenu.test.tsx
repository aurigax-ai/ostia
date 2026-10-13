import '@testing-library/jest-dom/vitest'
import { resetChatTools } from '@/stores/assist/chatToolsStore'
import { en } from '@shared/app/dict'
import type { ChatToolMode } from '@shared/assist'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatToolsMenu } from './ChatToolsMenu'

afterEach(() => {
  cleanup()
  resetChatTools()
  vi.mocked(window.ostia.chatTools.mcpRefresh).mockReset().mockResolvedValue([])
})

function Menu({ mode }: { mode: ChatToolMode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return <ChatToolsMenu sessionId="s1" mode={mode} open={open} onOpenChange={setOpen} />
}

describe('ChatToolsMenu', () => {
  it('says tools are described in the prompt when the model has no native tool calling', async () => {
    render(<Menu mode="prompted" />)
    await userEvent.click(screen.getByRole('button', { name: en.chatTools.menuTitle }))
    expect(await screen.findByText(en.chatTools.prompted)).toBeInTheDocument()
  })

  it('shows no such note when the model calls tools natively', async () => {
    render(<Menu mode="native" />)
    await userEvent.click(screen.getByRole('button', { name: en.chatTools.menuTitle }))
    expect(await screen.findByText(en.chatTools.menuDesc)).toBeInTheDocument()
    expect(screen.queryByText(en.chatTools.prompted)).not.toBeInTheDocument()
  })

  it('the human adds the server in Settings, signs in, tests it, and a chat lists its tools', async () => {
    vi.mocked(window.ostia.chatTools.mcpRefresh).mockResolvedValue([
      {
        name: 'fake',
        transport: 'http',
        state: 'ready',
        auth: 'signed-in',
        secretsSet: [],
        tools: ['echo', 'env', 'fail', 'slow', 'exit'].map((name) => ({
          name,
          description: '',
          inputSchema: {},
        })),
      },
    ])
    render(<Menu mode="native" />)
    await userEvent.click(screen.getByRole('button', { name: 'Tools for this chat' }))
    const tools = await screen.findByRole('dialog', { name: 'Tools for this chat' })
    expect(await within(tools).findByText('fake')).toBeInTheDocument()
    expect(within(tools).getByText('5 tools')).toBeInTheDocument()
  })
})
