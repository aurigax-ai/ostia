import '@testing-library/jest-dom/vitest'
import { en } from '@shared/app/dict'
import type { ChatToolMode } from '@shared/assist'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatToolsMenu } from './ChatToolsMenu'

afterEach(cleanup)

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
})
