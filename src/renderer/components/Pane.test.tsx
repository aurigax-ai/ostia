import { render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import type { PaneNode } from '../layout/types'
import { Pane } from './Pane'

const pane: PaneNode = { type: 'pane', id: 'p9', kind: 'terminal', title: 'zsh' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Pane', () => {
  it('activates when a portaled surface inside its slot is clicked or focused', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const host = document.createElement('div')
    const { container } = render(
      <>
        <Pane pane={pane} active={false} />
        {createPortal(<textarea aria-label="surface" />, host)}
      </>,
    )
    container.querySelector('.pane-body-term')?.appendChild(host)
    const surface = host.querySelector('textarea') as HTMLTextAreaElement

    surface.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'p9' })

    exec.mockClear()
    surface.focus()
    expect(exec).toHaveBeenCalledWith('pane.focus', { paneId: 'p9' })
  })

  it('does not re-focus a pane that is already active', () => {
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    const { container } = render(<Pane pane={pane} active />)
    container.querySelector('.pane')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(exec).not.toHaveBeenCalled()
  })
})
