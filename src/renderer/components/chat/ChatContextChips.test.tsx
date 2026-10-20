import '@testing-library/jest-dom/vitest'
import { en } from '@shared/app/dict'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatContextChips } from './ChatContextChips'
import type { ChatContext } from './useChatContext'

afterEach(cleanup)

const context = {
  options: {},
  enabled: new Set(),
  toggle: vi.fn(),
  editorFile: null,
  selectedText: undefined,
  available: [],
  selectedRef: null,
} as unknown as ChatContext

function chips(rules: { on: boolean; count: number; disabled: boolean; toggle: () => void }) {
  render(
    <ChatContextChips
      workspaceId="w1"
      chatKey="k"
      picking={false}
      setPicking={vi.fn()}
      pickerQuery=""
      setPickerQuery={vi.fn()}
      areaRef={{ current: null }}
      context={context}
      attachments={[]}
      willRedact={0}
      rules={rules}
    />,
  )
}

describe('the Rules chip', () => {
  it('shows how many rules go into the session and turns them off on a click', async () => {
    const toggle = vi.fn()
    chips({ on: true, count: 3, disabled: false, toggle })
    const chip = screen.getByRole('button', { name: new RegExp(en.agentPane.rules) })
    expect(chip).toHaveTextContent('3')
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(chip)
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('stays visible but unpressed while the rules are left out', () => {
    chips({ on: false, count: 0, disabled: false, toggle: vi.fn() })
    expect(screen.getByRole('button', { name: new RegExp(en.agentPane.rules) })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('is absent when there is nothing to include', () => {
    chips({ on: true, count: 0, disabled: false, toggle: vi.fn() })
    expect(screen.queryByRole('button', { name: new RegExp(en.agentPane.rules) })).toBeNull()
  })

  it('cannot be clicked while the agent works', () => {
    chips({ on: true, count: 2, disabled: true, toggle: vi.fn() })
    expect(screen.getByRole('button', { name: new RegExp(en.agentPane.rules) })).toBeDisabled()
  })
})
