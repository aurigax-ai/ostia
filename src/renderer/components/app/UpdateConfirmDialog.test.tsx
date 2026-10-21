import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useUpdateStore } from '@/stores/app/updateStore'
import { UpdateConfirmDialog } from './UpdateConfirmDialog'

const APT_COMMAND = 'sudo apt update && sudo apt install --only-upgrade ostia'

describe('UpdateConfirmDialog', () => {
  let init: ReturnType<typeof useUpdateStore.getState>

  beforeAll(() => {
    init = useUpdateStore.getState()
  })

  afterEach(() => {
    cleanup()
    useUpdateStore.setState(init, true)
  })

  it('shows the exact apt command and runs it only on Open terminal', async () => {
    render(<UpdateConfirmDialog />)
    act(() =>
      useUpdateStore.getState().receiveRelease({
        release: {
          version: '1.1.0',
          url: 'https://github.com/aurigax-ai/ostia/releases/tag/v1.1.0',
        },
        method: 'apt',
        updateCommand: APT_COMMAND,
        replace: null,
      }),
    )
    act(() => useUpdateStore.getState().askUpdate())

    const dialog = screen.getByRole('dialog', { name: 'Update Ostia with apt' })
    expect(dialog).toHaveTextContent(APT_COMMAND)
    expect(window.ostia.update.runUpdate).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    })
    expect(window.ostia.update.runUpdate).toHaveBeenCalledTimes(1)
    expect(useUpdateStore.getState().confirming).toBe(false)
  })
})
